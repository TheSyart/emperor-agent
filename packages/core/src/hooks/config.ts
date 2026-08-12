import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  AtomicSnapshot,
  type PersistenceAdapter,
  type SnapshotCodec,
} from '../store/persistence'
import {
  HOOK_EVENT_NAMES,
  type HookDefinition,
  type HookDiagnostic,
  type HookGroup,
  type HookSnapshot,
  type HookSource,
  type HookSourceV2,
  type HooksConfig,
  type HooksConfigV2,
  type ProjectHookTrustStatus,
  type ResolvedHookGroup,
} from './models'
import {
  defaultHooksConfig,
  defaultHooksConfigV2,
  parseHooksConfig,
  parseHooksConfigV2,
  serializeHooksConfigV2,
} from './schema'

export const HOOKS_CONFIG_FILE = 'hooks_config.json'

export interface HookConfigSourceInfo extends HookSource {
  enabled: boolean
  diagnostics: HookDiagnostic[]
}
export interface HookConfigLoadResult {
  config: HooksConfig
  diagnostics: HookDiagnostic[]
  sources: HookConfigSourceInfo[]
}

export class HookConfigLoader {
  readonly stateRoot: string
  readonly globalConfigPath: string
  private readonly persistenceAdapter?: PersistenceAdapter

  constructor(opts: {
    stateRoot: string
    persistenceAdapter?: PersistenceAdapter
  }) {
    this.stateRoot = resolve(opts.stateRoot)
    this.globalConfigPath = join(this.stateRoot, HOOKS_CONFIG_FILE)
    this.persistenceAdapter = opts.persistenceAdapter
  }

  async load(
    opts: { projectRoot?: string | null } = {},
  ): Promise<HookConfigLoadResult> {
    const diagnostics: HookDiagnostic[] = []
    const globalSource: HookSource = {
      kind: 'global',
      path: this.globalConfigPath,
      readonly: false,
    }
    const globalSnapshot = await hookJsonSnapshot(
      this.globalConfigPath,
      this.persistenceAdapter,
    ).read({ fallback: null })
    if (
      globalSnapshot.receipt.recoveryAction === 'quarantined_corrupt_snapshot'
    )
      diagnostics.push({
        code: 'corrupt_config',
        path: this.globalConfigPath,
        message: `Corrupt hooks config preserved at ${String(globalSnapshot.receipt.corruptionBackup ?? '')}`,
      })
    const globalRaw = globalSnapshot.value
    const globalParsed = parseHooksConfig(globalRaw, { source: globalSource })
    diagnostics.push(...globalParsed.diagnostics)
    const sources: HookConfigSourceInfo[] = [
      {
        ...globalSource,
        enabled: globalParsed.config.enabled,
        diagnostics: globalParsed.diagnostics,
      },
    ]

    const config = cloneConfig(globalParsed.config)
    const seen = new Set<string>()
    recordSeenHooks(seen, this.stateRoot, config)

    const projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : null
    if (projectRoot && config.projectHooks.enabled) {
      const projectFiles = [
        join(projectRoot, '.emperor', 'settings.json'),
        join(projectRoot, '.emperor', 'settings.local.json'),
      ]
      for (const path of projectFiles) {
        const loaded = await this.loadProjectFile(path)
        if (!loaded) continue
        sources.push(loaded.source)
        diagnostics.push(...loaded.source.diagnostics)
        if (!loaded.parsed.config.enabled) continue
        mergeHooks(config, loaded.parsed.config, seen, projectRoot)
      }
    }

    return { config, diagnostics, sources }
  }

  async saveGlobalConfig(input: unknown): Promise<HookConfigLoadResult> {
    const parsed = parseHooksConfig(input, {
      source: { kind: 'global', path: this.globalConfigPath, readonly: false },
    })
    if (parsed.diagnostics.length > 0) {
      return {
        config: parsed.config,
        diagnostics: parsed.diagnostics,
        sources: [
          {
            kind: 'global',
            path: this.globalConfigPath,
            readonly: false,
            enabled: parsed.config.enabled,
            diagnostics: parsed.diagnostics,
          },
        ],
      }
    }
    await hookJsonSnapshot(
      this.globalConfigPath,
      this.persistenceAdapter,
    ).write(serializeConfig(parsed.config))
    return this.load()
  }

  private async loadProjectFile(path: string): Promise<{
    parsed: ReturnType<typeof parseHooksConfig>
    source: HookConfigSourceInfo
  } | null> {
    if (!existsSync(path)) return null
    const source: HookSource = { kind: 'project', path, readonly: true }
    let raw: unknown
    try {
      raw = JSON.parse((await readFile(path, 'utf8')) || '{}')
    } catch (error) {
      const diagnostics = [
        {
          code: 'corrupt_project_config',
          path,
          message: error instanceof Error ? error.message : String(error),
        },
      ]
      return {
        parsed: { config: defaultHooksConfig(), diagnostics },
        source: { ...source, enabled: false, diagnostics },
      }
    }
    const parsed = parseHooksConfig(raw, { source })
    return {
      parsed,
      source: {
        ...source,
        enabled: parsed.config.enabled,
        diagnostics: parsed.diagnostics,
      },
    }
  }
}

const PROJECT_TRUST_FILE = join('hooks', 'project-trust.json')
const SOURCE_RANK: Record<
  'global' | 'project' | 'project-local' | 'session',
  number
> = {
  global: 100,
  project: 200,
  'project-local': 300,
  session: 400,
}

interface ProjectTrustRecord {
  digest: string
  trustedAt: string | null
  revokedAt: string | null
}

interface ProjectTrustFile {
  version: 1
  records: Record<string, ProjectTrustRecord>
}

interface SessionHookSource {
  sourceId: string
  raw: unknown
}

export class ProjectHookTrustStore {
  readonly stateRoot: string
  readonly path: string
  private readonly persistenceAdapter?: PersistenceAdapter

  constructor(opts: {
    stateRoot: string
    persistenceAdapter?: PersistenceAdapter
  }) {
    this.stateRoot = resolve(opts.stateRoot)
    this.path = join(this.stateRoot, PROJECT_TRUST_FILE)
    this.persistenceAdapter = opts.persistenceAdapter
  }

  async status(projectRoot: string): Promise<ProjectHookTrustStatus> {
    const canonicalRoot = await canonicalProjectRoot(projectRoot)
    const digest = await projectHooksDigest(canonicalRoot)
    const file = await this.read()
    const record = file.records[canonicalRoot]
    let status: ProjectHookTrustStatus['status'] = 'untrusted'
    if (record && !record.revokedAt)
      status = record.digest === digest ? 'trusted' : 'stale'
    return { canonicalRoot, digest, status }
  }

  async set(opts: {
    projectRoot: string
    expectedDigest: string
    trusted: boolean
  }): Promise<ProjectHookTrustStatus> {
    const current = await this.status(opts.projectRoot)
    if (current.digest !== opts.expectedDigest)
      throw new Error(
        'project hooks digest changed before trust could be saved',
      )
    const file = await this.read()
    const now = new Date().toISOString()
    file.records[current.canonicalRoot] = opts.trusted
      ? { digest: current.digest, trustedAt: now, revokedAt: null }
      : {
          digest: current.digest,
          trustedAt: file.records[current.canonicalRoot]?.trustedAt ?? null,
          revokedAt: now,
        }
    await hookJsonSnapshot(this.path, this.persistenceAdapter).write(file)
    return { ...current, status: opts.trusted ? 'trusted' : 'untrusted' }
  }

  private async read(): Promise<ProjectTrustFile> {
    const loaded = (
      await hookJsonSnapshot(this.path, this.persistenceAdapter).read({
        fallback: null,
      })
    ).value
    const data = objectOrNull(loaded)
    const recordsRaw = objectOrNull(data?.records)
    const records: Record<string, ProjectTrustRecord> = {}
    for (const [root, value] of Object.entries(recordsRaw ?? {})) {
      const record = objectOrNull(value)
      if (!record || typeof record.digest !== 'string') continue
      records[root] = {
        digest: record.digest,
        trustedAt:
          typeof record.trustedAt === 'string' ? record.trustedAt : null,
        revokedAt:
          typeof record.revokedAt === 'string' ? record.revokedAt : null,
      }
    }
    return { version: 1, records }
  }
}

export class HookSessionRegistry {
  private readonly sourcesBySession = new Map<string, SessionHookSource[]>()

  register(
    sessionId: string,
    config: unknown,
    opts: { sourceId?: string } = {},
  ): void {
    const cleanSessionId = String(sessionId).trim()
    if (!cleanSessionId)
      throw new Error('sessionId is required for session hooks')
    const sourceId = String(opts.sourceId ?? 'session').trim() || 'session'
    const sources = [...(this.sourcesBySession.get(cleanSessionId) ?? [])]
    const next = { sourceId, raw: config }
    const index = sources.findIndex((source) => source.sourceId === sourceId)
    if (index >= 0) sources[index] = next
    else sources.push(next)
    this.sourcesBySession.set(cleanSessionId, sources)
  }

  clear(sessionId: string): void {
    this.sourcesBySession.delete(String(sessionId).trim())
  }

  sources(sessionId: string | null | undefined): SessionHookSource[] {
    if (!sessionId) return []
    return [...(this.sourcesBySession.get(String(sessionId).trim()) ?? [])]
  }
}

export class HookSourceResolver {
  readonly stateRoot: string
  readonly globalConfigPath: string
  readonly trustStore: ProjectHookTrustStore
  readonly sessionRegistry: HookSessionRegistry
  private readonly persistenceAdapter?: PersistenceAdapter

  constructor(opts: {
    stateRoot: string
    sessionRegistry?: HookSessionRegistry
    persistenceAdapter?: PersistenceAdapter
  }) {
    this.stateRoot = resolve(opts.stateRoot)
    this.globalConfigPath = join(this.stateRoot, HOOKS_CONFIG_FILE)
    this.persistenceAdapter = opts.persistenceAdapter
    this.trustStore = new ProjectHookTrustStore({
      stateRoot: this.stateRoot,
      persistenceAdapter: this.persistenceAdapter,
    })
    this.sessionRegistry = opts.sessionRegistry ?? new HookSessionRegistry()
  }

  async resolve(
    opts: { projectRoot?: string | null; sessionId?: string | null } = {},
  ): Promise<HookSnapshot> {
    const diagnostics: HookDiagnostic[] = []
    const sources: HookSourceV2[] = []
    const effective = new Map<string, ResolvedHookGroup>()

    const globalSnapshot = await hookJsonSnapshot(
      this.globalConfigPath,
      this.persistenceAdapter,
    ).read({ fallback: null })
    if (
      globalSnapshot.receipt.recoveryAction === 'quarantined_corrupt_snapshot'
    )
      diagnostics.push({
        code: 'corrupt_config',
        path: this.globalConfigPath,
        message: `Corrupt hooks config preserved at ${String(globalSnapshot.receipt.corruptionBackup ?? '')}`,
      })
    const globalRaw = globalSnapshot.value
    const globalParsed = parseHooksConfigV2(globalRaw, { sourceKind: 'global' })
    diagnostics.push(...globalParsed.diagnostics)
    const globalSource = sourceV2({
      id: 'global',
      kind: 'global',
      path: this.globalConfigPath,
      revision: digestValue(serializeHooksConfigV2(globalParsed.config)),
      active: globalParsed.config.enabled,
      blockedReason: globalParsed.config.enabled ? null : 'hooks_disabled',
    })
    sources.push(globalSource)
    if (globalSource.active)
      mergeResolvedGroups(effective, globalParsed.config, globalSource)

    let projectTrust: ProjectHookTrustStatus | null = null
    const projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : null
    if (projectRoot && globalParsed.config.projectHooks.enabled) {
      projectTrust = await this.trustStore.status(projectRoot)
      const projectFiles: Array<{
        id: string
        kind: 'project' | 'project-local'
        path: string
      }> = [
        {
          id: 'project',
          kind: 'project',
          path: join(projectTrust.canonicalRoot, '.emperor', 'settings.json'),
        },
        {
          id: 'project-local',
          kind: 'project-local',
          path: join(
            projectTrust.canonicalRoot,
            '.emperor',
            'settings.local.json',
          ),
        },
      ]
      for (const descriptor of projectFiles) {
        const loaded = await readProjectConfigV2(
          descriptor.path,
          descriptor.kind,
        )
        if (!loaded) continue
        diagnostics.push(...loaded.diagnostics)
        const trustBlocked =
          projectTrust.status === 'trusted'
            ? null
            : projectTrust.status === 'stale'
              ? 'project_trust_stale'
              : 'project_untrusted'
        const active =
          globalSource.active && loaded.config.enabled && trustBlocked === null
        const source = sourceV2({
          ...descriptor,
          revision: loaded.revision,
          active,
          blockedReason: !globalSource.active
            ? 'hooks_disabled'
            : !loaded.config.enabled
              ? 'source_disabled'
              : trustBlocked,
        })
        sources.push(source)
        if (source.active) mergeResolvedGroups(effective, loaded.config, source)
      }
    }

    const sessionSources = this.sessionRegistry.sources(opts.sessionId)
    for (let index = 0; index < sessionSources.length; index++) {
      const registered = sessionSources[index]!
      const parsed = parseHooksConfigV2(registered.raw, {
        sourceKind: 'session',
      })
      diagnostics.push(
        ...parsed.diagnostics.map((item) => ({
          ...item,
          path: `session.${registered.sourceId}.${item.path}`,
        })),
      )
      const source = sourceV2({
        id: `session:${registered.sourceId}`,
        kind: 'session',
        path: `session://${String(opts.sessionId ?? '')}/${registered.sourceId}`,
        revision: digestValue(serializeHooksConfigV2(parsed.config)),
        active: globalSource.active && parsed.config.enabled,
        blockedReason:
          globalSource.active && parsed.config.enabled
            ? null
            : 'hooks_disabled',
      })
      source.rank += index
      sources.push(source)
      if (source.active) mergeResolvedGroups(effective, parsed.config, source)
    }

    const groups = orderedResolvedGroups(effective)
    const config = effectiveConfig(globalParsed.config, groups)
    const revision = digestValue({
      config: serializeHooksConfigV2(config),
      sources: sources.map((source) => ({
        id: source.id,
        revision: source.revision,
        active: source.active,
      })),
    })
    return deepFreeze({
      revision,
      config,
      groups,
      sources,
      diagnostics,
      projectTrust,
    })
  }
}

export class HookSnapshotStore {
  private readonly resolver: HookSourceResolver
  private readonly reviewCandidate:
    | ((
        previous: HookSnapshot | null,
        candidate: HookSnapshot,
        scope: { projectRoot?: string | null; sessionId?: string | null },
      ) => boolean | Promise<boolean>)
    | null
  private readonly accepted = new Map<string, HookSnapshot>()

  constructor(opts: {
    resolver: HookSourceResolver
    reviewCandidate?:
      | ((
          previous: HookSnapshot | null,
          candidate: HookSnapshot,
          scope: { projectRoot?: string | null; sessionId?: string | null },
        ) => boolean | Promise<boolean>)
      | null
  }) {
    this.resolver = opts.resolver
    this.reviewCandidate = opts.reviewCandidate ?? null
  }

  async get(
    opts: { projectRoot?: string | null; sessionId?: string | null } = {},
  ): Promise<HookSnapshot> {
    const key = `${resolve(opts.projectRoot ?? '')}\0${String(opts.sessionId ?? '')}`
    const previous = this.accepted.get(key) ?? null
    const candidate = await this.resolver.resolve(opts)
    if (!previous) {
      this.accepted.set(key, candidate)
      return candidate
    }
    if (previous.revision === candidate.revision) return previous
    let accepted = true
    try {
      if (this.reviewCandidate)
        accepted = await this.reviewCandidate(previous, candidate, opts)
    } catch (error) {
      return rejectedSnapshot(
        previous,
        'candidate_review_failed',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!accepted)
      return rejectedSnapshot(
        previous,
        'candidate_rejected',
        `Hook snapshot candidate ${candidate.revision} was rejected`,
      )
    this.accepted.set(key, candidate)
    return candidate
  }

  accept(
    snapshot: HookSnapshot,
    opts: { projectRoot?: string | null; sessionId?: string | null } = {},
  ): void {
    this.accepted.set(snapshotKey(opts), snapshot)
  }
}

function snapshotKey(opts: {
  projectRoot?: string | null
  sessionId?: string | null
}): string {
  return `${resolve(opts.projectRoot ?? '')}\0${String(opts.sessionId ?? '')}`
}

const HOOK_JSON_SNAPSHOT_CODEC: SnapshotCodec<unknown> = {
  schemaVersion: 1,
  encode(value) {
    return value
  },
  decode(input) {
    return { value: input, schemaVersion: 1 }
  },
}

function hookJsonSnapshot(
  path: string,
  adapter?: PersistenceAdapter,
): AtomicSnapshot<unknown> {
  return new AtomicSnapshot({
    path,
    codec: HOOK_JSON_SNAPSHOT_CODEC,
    adapter,
    fileMode: 0o600,
  })
}

function cloneConfig(config: HooksConfig): HooksConfig {
  const hooks: HooksConfig['hooks'] = {}
  for (const [eventName, entries] of Object.entries(config.hooks) as Array<
    [keyof HooksConfig['hooks'], HookDefinition[] | undefined]
  >) {
    if (entries?.length)
      hooks[eventName] = entries.map((entry) => ({
        ...entry,
        handler: { ...entry.handler },
      }))
  }
  return {
    version: 1,
    enabled: config.enabled,
    projectHooks: { enabled: config.projectHooks.enabled },
    hooks,
  }
}

function mergeHooks(
  target: HooksConfig,
  incoming: HooksConfig,
  seen: Set<string>,
  sourceRoot: string,
): void {
  for (const [eventName, entries] of Object.entries(incoming.hooks) as Array<
    [keyof HooksConfig['hooks'], HookDefinition[] | undefined]
  >) {
    if (!entries?.length) continue
    const existing = target.hooks[eventName] ?? []
    for (const hook of entries) {
      const key = dedupeKey(sourceRoot, hook)
      if (seen.has(key)) continue
      seen.add(key)
      existing.push(hook)
    }
    if (existing.length > 0) target.hooks[eventName] = existing
  }
}

function recordSeenHooks(
  seen: Set<string>,
  sourceRoot: string,
  config: HooksConfig,
): void {
  for (const entries of Object.values(config.hooks)) {
    for (const hook of entries ?? [])
      seen.add(dedupeKey(sourceRootForHook(sourceRoot, hook), hook))
  }
}

function sourceRootForHook(fallback: string, hook: HookDefinition): string {
  return hook.source?.kind === 'global' ? dirname(hook.source.path) : fallback
}

function dedupeKey(sourceRoot: string, hook: HookDefinition): string {
  return JSON.stringify({
    sourceRoot: resolve(sourceRoot),
    eventName: hook.eventName,
    matcher: hook.matcher,
    condition: hook.condition,
    handler: hook.handler,
  })
}

function serializeConfig(config: HooksConfig): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {}
  for (const [eventName, entries] of Object.entries(config.hooks)) {
    hooks[eventName] = (entries ?? []).map((hook) => ({
      id: hook.id,
      enabled: hook.enabled,
      matcher: hook.matcher,
      if: hook.condition,
      handler: hook.handler,
    }))
  }
  return {
    version: config.version,
    enabled: config.enabled,
    projectHooks: { enabled: config.projectHooks.enabled },
    hooks,
  }
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  const requested = resolve(projectRoot)
  try {
    return await realpath(requested)
  } catch {
    return requested
  }
}

async function projectHooksDigest(canonicalRoot: string): Promise<string> {
  const hash = createHash('sha256')
  for (const name of ['settings.json', 'settings.local.json']) {
    const path = join(canonicalRoot, '.emperor', name)
    hash.update(name)
    hash.update('\0')
    try {
      hash.update(await readFile(path))
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (code !== 'ENOENT') throw error
      hash.update('<missing>')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function readProjectConfigV2(
  path: string,
  sourceKind: 'project' | 'project-local',
): Promise<{
  config: HooksConfigV2
  diagnostics: HookDiagnostic[]
  revision: string
} | null> {
  if (!existsSync(path)) return null
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return {
      config: { ...defaultHooksConfigV2(), enabled: false },
      diagnostics: [
        {
          code: 'project_config_read_failed',
          path,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      revision: digestValue({ path, error: String(error) }),
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text || '{}')
  } catch (error) {
    return {
      config: { ...defaultHooksConfigV2(), enabled: false },
      diagnostics: [
        {
          code: 'corrupt_project_config',
          path,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      revision: digestText(text),
    }
  }
  const parsed = parseHooksConfigV2(raw, { sourceKind })
  return { ...parsed, revision: digestText(text) }
}

function sourceV2(opts: {
  id: string
  kind: 'global' | 'project' | 'project-local' | 'session'
  path: string
  revision: string
  active: boolean
  blockedReason: string | null
}): HookSourceV2 {
  return {
    id: opts.id,
    kind: opts.kind,
    rank: SOURCE_RANK[opts.kind],
    path: opts.path,
    readonly: opts.kind !== 'global',
    revision: opts.revision,
    active: opts.active,
    blockedReason: opts.blockedReason,
  }
}

function mergeResolvedGroups(
  target: Map<string, ResolvedHookGroup>,
  config: HooksConfigV2,
  source: HookSourceV2,
): void {
  for (const eventName of HOOK_EVENT_NAMES) {
    for (const group of config.hooks[eventName] ?? []) {
      if (!group.enabled) continue
      const key = `${eventName}\0${group.id}`
      if (target.has(key)) target.delete(key)
      target.set(key, {
        eventName,
        group: cloneV2Group(group),
        source: { ...source },
      })
    }
  }
}

function orderedResolvedGroups(
  groups: Map<string, ResolvedHookGroup>,
): ResolvedHookGroup[] {
  const values = [...groups.values()]
  return HOOK_EVENT_NAMES.flatMap((eventName) =>
    values.filter((group) => group.eventName === eventName),
  )
}

function effectiveConfig(
  globalConfig: HooksConfigV2,
  groups: ResolvedHookGroup[],
): HooksConfigV2 {
  const hooks: HooksConfigV2['hooks'] = {}
  for (const resolvedGroup of groups) {
    const eventGroups = hooks[resolvedGroup.eventName] ?? []
    eventGroups.push(cloneV2Group(resolvedGroup.group))
    hooks[resolvedGroup.eventName] = eventGroups
  }
  return {
    version: 2,
    enabled: globalConfig.enabled,
    projectHooks: { enabled: globalConfig.projectHooks.enabled },
    policy: {
      ...globalConfig.policy,
      command: {
        ...globalConfig.policy.command,
        allowedEnv: [...globalConfig.policy.command.allowedEnv],
      },
      http: {
        ...globalConfig.policy.http,
        allowedUrlPatterns: [...globalConfig.policy.http.allowedUrlPatterns],
        allowedEnv: [...globalConfig.policy.http.allowedEnv],
      },
      prompt: { ...globalConfig.policy.prompt },
      agent: { ...globalConfig.policy.agent },
    },
    hooks,
  }
}

function cloneV2Group(group: HookGroup): HookGroup {
  return {
    ...group,
    handlers: group.handlers.map((handler) => {
      if (handler.type === 'command')
        return {
          ...handler,
          args: [...handler.args],
          allowedEnv: [...handler.allowedEnv],
        }
      if (handler.type === 'http')
        return {
          ...handler,
          headers: { ...handler.headers },
          allowedEnv: [...handler.allowedEnv],
        }
      return { ...handler }
    }),
  }
}

function digestValue(value: unknown): string {
  return digestText(JSON.stringify(sortKeysDeep(value)))
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  for (const child of Object.values(value as Record<string, unknown>))
    deepFreeze(child)
  return Object.freeze(value)
}

function rejectedSnapshot(
  previous: HookSnapshot,
  code: string,
  message: string,
): HookSnapshot {
  return deepFreeze({
    ...previous,
    diagnostics: [...previous.diagnostics, { code, path: 'snapshot', message }],
  })
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
