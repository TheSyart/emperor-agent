import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, win32 } from 'node:path'
import { z } from 'zod'
import {
  CONFIG_LAYER_PRECEDENCE,
  ConfigResolver,
  defineConfigKey,
} from '../config/resolver'

export const SOURCE_PRECEDENCE = {
  builtin: CONFIG_LAYER_PRECEDENCE.builtin,
  plugin: 200,
  user: CONFIG_LAYER_PRECEDENCE.user,
  project: CONFIG_LAYER_PRECEDENCE.project,
  managed: CONFIG_LAYER_PRECEDENCE.managed,
} as const

export type ExtensionSourceKind = keyof typeof SOURCE_PRECEDENCE
export type ExtensionTrust =
  'system' | 'verified_plugin' | 'user' | 'project' | 'managed' | 'untrusted'
export type AgentMemoryMode = 'none' | 'read' | 'read-write'
export type AgentFilesystemPolicy = 'read-only' | 'workspace-write'
export type AgentExecutionPolicy = 'deny' | 'policy'

export interface AgentDefinition {
  schemaVersion: 1
  name: string
  aliases: string[]
  description: string
  prompt: string
  model: {
    inherit: boolean
    allowedProfiles: string[]
  }
  tools: { allow: string[] }
  skills: { allow: string[] }
  hooks: { allow: string[] }
  mcp: { servers: string[] }
  memory: {
    mode: AgentMemoryMode
    scopes: Array<'session' | 'project' | 'global'>
  }
  completion: {
    maxTurns: number
    requiredSections: string[]
  }
  sandbox: {
    filesystem: AgentFilesystemPolicy
    network: AgentExecutionPolicy
    process: AgentExecutionPolicy
  }
  delegation: { planReadonlyExplorer: boolean }
}

export interface AgentSessionPolicy {
  allowedModelProfiles?: string[]
  toolNames?: string[]
  skillNames?: string[]
  hookIds?: string[]
  mcpServers?: string[]
  memoryMode?: AgentMemoryMode
  memoryScopes?: Array<'session' | 'project' | 'global'>
  maxTurns?: number
  sandbox?: Partial<AgentDefinition['sandbox']>
}

export interface ExtensionSourceInput {
  id: string
  kind: ExtensionSourceKind
  root: string
  manifests: string[]
  /** Assigned by the loader/trust store. Manifest content cannot set trust. */
  trusted?: boolean
  /** Only a verified plugin package may become active. */
  signatureVerified?: boolean
  readOnly?: boolean
}

export interface ExtensionSourceSnapshot {
  id: string
  identity: string
  kind: ExtensionSourceKind
  rank: number
  trust: ExtensionTrust
  canonicalRoot: string
  manifests: string[]
  readOnly: boolean
  active: boolean
  blockedReason: string | null
}

export interface ExtensionDiagnostic {
  code: string
  severity: 'error' | 'warning'
  sourceId: string
  path: string
  agentName: string | null
  message: string
}

export interface ResolvedAgentDefinition {
  definition: AgentDefinition
  source: ExtensionSourceSnapshot
  manifestPath: string
  promptPath: string
  systemPrompt: string
  revision: string
  overriddenSources: Array<{
    source: ExtensionSourceSnapshot
    revision: string
  }>
}

export interface ExtensionSnapshot {
  schemaVersion: 1
  revision: string
  sources: ExtensionSourceSnapshot[]
  agents: ResolvedAgentDefinition[]
  aliases: Record<string, string>
  diagnostics: ExtensionDiagnostic[]
}

export interface ExtensionResolverOptions {
  sources: ExtensionSourceInput[]
}

const MAX_MANIFESTS_PER_SOURCE = 32
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_AGENTS_PER_MANIFEST = 100
const MAX_PROMPT_BYTES = 256 * 1024
const AGENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

const agentNameSchema = z.string().regex(AGENT_NAME_RE)
const resourceIdSchema = z.string().regex(RESOURCE_ID_RE)
const resourceListSchema = z
  .array(resourceIdSchema)
  .max(256)
  .refine(uniqueValues)
const resourceAllowSchema = z
  .array(z.union([resourceIdSchema, z.literal('*')]))
  .max(256)
  .refine(uniqueValues)
const agentDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: agentNameSchema,
    aliases: z.array(agentNameSchema).max(32).refine(uniqueValues),
    description: z.string().trim().min(1).max(2_048),
    prompt: z.string().trim().min(1).max(512),
    model: z
      .object({
        inherit: z.boolean(),
        allowedProfiles: z.array(resourceIdSchema).max(64).refine(uniqueValues),
      })
      .strict(),
    tools: z.object({ allow: resourceListSchema }).strict(),
    skills: z.object({ allow: resourceAllowSchema }).strict(),
    hooks: z.object({ allow: resourceListSchema }).strict(),
    mcp: z
      .object({
        servers: z.array(resourceIdSchema).max(128).refine(uniqueValues),
      })
      .strict(),
    memory: z
      .object({
        mode: z.enum(['none', 'read', 'read-write']),
        scopes: z
          .array(z.enum(['session', 'project', 'global']))
          .max(3)
          .refine(uniqueValues),
      })
      .strict(),
    completion: z
      .object({
        maxTurns: z.number().int().min(1).max(100),
        requiredSections: z
          .array(z.string().trim().min(1).max(128))
          .min(1)
          .max(16)
          .refine(uniqueValues),
      })
      .strict(),
    sandbox: z
      .object({
        filesystem: z.enum(['read-only', 'workspace-write']),
        network: z.enum(['deny', 'policy']),
        process: z.enum(['deny', 'policy']),
      })
      .strict(),
    delegation: z.object({ planReadonlyExplorer: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (definition.aliases.includes(definition.name))
      context.addIssue({
        code: 'custom',
        path: ['aliases'],
        message: 'canonical name cannot also be an alias',
      })
    if (
      !definition.model.inherit &&
      definition.model.allowedProfiles.length === 0
    )
      context.addIssue({
        code: 'custom',
        path: ['model', 'allowedProfiles'],
        message: 'an explicit model policy requires an allowlist',
      })
    if (
      (definition.memory.mode === 'none') !==
      (definition.memory.scopes.length === 0)
    )
      context.addIssue({
        code: 'custom',
        path: ['memory', 'scopes'],
        message: 'memory mode and scopes are inconsistent',
      })
    if (
      definition.delegation.planReadonlyExplorer &&
      definition.sandbox.filesystem !== 'read-only'
    )
      context.addIssue({
        code: 'custom',
        path: ['sandbox', 'filesystem'],
        message: 'plan read-only agents require a read-only sandbox policy',
      })
  })

const agentBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    agents: z.array(z.unknown()).max(MAX_AGENTS_PER_MANIFEST),
  })
  .strict()

interface AgentCandidate extends ResolvedAgentDefinition {
  order: number
}

export class ExtensionResolver {
  private readonly sources: ExtensionSourceInput[]

  constructor(opts: ExtensionResolverOptions) {
    this.sources = [...opts.sources]
  }

  resolve(): ExtensionSnapshot {
    const diagnostics: ExtensionDiagnostic[] = []
    const sources = this.resolveSources(diagnostics)
    const candidates: AgentCandidate[] = []
    const canonicalManifests = new Set<string>()
    let order = 0
    for (const source of sources) {
      if (!source.active) continue
      const input = this.sources.find(
        (item) => item.id === source.id && item.kind === source.kind,
      )
      if (!input) continue
      for (const manifest of source.manifests) {
        const manifestPath = containedRegularFile({
          source,
          base: source.canonicalRoot,
          requested: manifest,
          label: 'manifest',
          maxBytes: MAX_MANIFEST_BYTES,
          diagnostics,
        })
        if (!manifestPath) continue
        if (canonicalManifests.has(manifestPath)) {
          diagnostics.push(
            diagnostic(
              'canonical_duplicate_manifest',
              source,
              manifest,
              null,
              'Manifest resolves to a canonical path that was already loaded.',
            ),
          )
          continue
        }
        canonicalManifests.add(manifestPath)
        const bundle = readBundle(manifestPath, source, manifest, diagnostics)
        if (!bundle) continue
        for (let index = 0; index < bundle.agents.length; index += 1) {
          const parsed = agentDefinitionSchema.safeParse(bundle.agents[index])
          if (!parsed.success) {
            diagnostics.push(
              diagnostic(
                'invalid_agent_definition',
                source,
                `${manifest}#agents[${index}]`,
                safeAgentName(bundle.agents[index]),
                `Agent definition is invalid at ${safeIssuePath(parsed.error)}.`,
              ),
            )
            continue
          }
          const definition = parsed.data as AgentDefinition
          const promptPath = containedRegularFile({
            source,
            base: dirname(manifestPath),
            requested: definition.prompt,
            label: 'prompt',
            maxBytes: MAX_PROMPT_BYTES,
            diagnostics,
            agentName: definition.name,
          })
          if (!promptPath) continue
          const systemPrompt = readFileSync(promptPath, 'utf8').trim()
          if (!systemPrompt) {
            diagnostics.push(
              diagnostic(
                'prompt_empty',
                source,
                definition.prompt,
                definition.name,
                'Agent prompt must not be empty.',
              ),
            )
            continue
          }
          candidates.push({
            definition,
            source,
            manifestPath,
            promptPath,
            systemPrompt,
            revision: digest({ definition, systemPrompt }),
            overriddenSources: [],
            order: order++,
          })
        }
      }
    }

    candidates.sort(compareCandidates)
    const winners = new Map<string, AgentCandidate>()
    for (const candidate of candidates) {
      const existing = winners.get(candidate.definition.name)
      if (!existing) {
        winners.set(candidate.definition.name, candidate)
        continue
      }
      diagnostics.push(
        diagnostic(
          existing.source.identity === candidate.source.identity
            ? 'duplicate_agent_name'
            : 'cross_source_collision',
          candidate.source,
          relative(candidate.source.canonicalRoot, candidate.manifestPath),
          candidate.definition.name,
          existing.source.identity === candidate.source.identity
            ? 'Duplicate agent name was rejected within one source.'
            : `Agent name collides with higher-precedence source '${existing.source.id}'; the lower-precedence definition was rejected.`,
        ),
      )
      existing.overriddenSources.push({
        source: candidate.source,
        revision: candidate.revision,
      })
    }

    const acceptedByPrecedence = [...winners.values()].sort(compareCandidates)
    const canonicalNames = new Set(
      acceptedByPrecedence.map((item) => item.definition.name),
    )
    const aliases: Record<string, string> = {}
    for (const candidate of acceptedByPrecedence) {
      for (const alias of candidate.definition.aliases) {
        const owner = aliases[alias]
        if (
          canonicalNames.has(alias) ||
          (owner && owner !== candidate.definition.name)
        ) {
          diagnostics.push(
            diagnostic(
              'alias_collision',
              candidate.source,
              relative(candidate.source.canonicalRoot, candidate.manifestPath),
              candidate.definition.name,
              'Agent alias collides with a canonical name or higher-precedence alias and was rejected.',
            ),
          )
          continue
        }
        aliases[alias] = candidate.definition.name
      }
    }

    const agents = [...winners.values()]
      .sort((left, right) =>
        left.definition.name.localeCompare(right.definition.name),
      )
      .map(({ order: _order, ...candidate }) => candidate)
    const snapshot: ExtensionSnapshot = {
      schemaVersion: 1,
      revision: digest({
        sources: sources.map(sourceRevisionInput),
        agents: agents.map((item) => ({
          name: item.definition.name,
          revision: item.revision,
          source: item.source.identity,
        })),
        aliases,
        diagnostics,
      }),
      sources,
      agents,
      aliases: sortRecord(aliases),
      diagnostics,
    }
    return deepFreeze(snapshot)
  }

  private resolveSources(
    diagnostics: ExtensionDiagnostic[],
  ): ExtensionSourceSnapshot[] {
    const snapshots = this.sources.map((input) =>
      resolveSource(input, diagnostics),
    )
    snapshots.sort(compareSources)
    const sourceIds = new Set<string>()
    const canonicalRoots = new Set<string>()
    for (const source of snapshots) {
      if (sourceIds.has(source.id)) {
        source.active = false
        source.blockedReason = 'duplicate_source_id'
        source.trust = 'untrusted'
        diagnostics.push(
          diagnostic(
            'duplicate_source_id',
            source,
            '.',
            null,
            'Duplicate extension source id was rejected.',
          ),
        )
        continue
      }
      sourceIds.add(source.id)
      if (!source.active) continue
      if (canonicalRoots.has(source.canonicalRoot)) {
        source.active = false
        source.blockedReason = 'canonical_duplicate_source'
        source.trust = 'untrusted'
        diagnostics.push(
          diagnostic(
            'canonical_duplicate_source',
            source,
            '.',
            null,
            'Extension source resolves to a canonical root already owned by a higher-precedence source.',
          ),
        )
        continue
      }
      canonicalRoots.add(source.canonicalRoot)
    }
    return snapshots
  }
}

export function applyAgentSessionPolicy(
  definition: AgentDefinition,
  policy: AgentSessionPolicy,
): AgentDefinition {
  const next = structuredClone(definition)
  next.model.allowedProfiles = restrictOpenAllowList(
    next.model.allowedProfiles,
    policy.allowedModelProfiles,
  )
  next.tools.allow = restrictAllowList(next.tools.allow, policy.toolNames)
  next.skills.allow = restrictAllowList(next.skills.allow, policy.skillNames)
  next.hooks.allow = restrictAllowList(next.hooks.allow, policy.hookIds)
  next.mcp.servers = restrictAllowList(next.mcp.servers, policy.mcpServers)
  if (policy.memoryMode)
    next.memory.mode = stricterMemoryMode(next.memory.mode, policy.memoryMode)
  next.memory.scopes = restrictAllowList(
    next.memory.scopes,
    policy.memoryScopes,
  ) as AgentDefinition['memory']['scopes']
  if (Number.isFinite(policy.maxTurns))
    next.completion.maxTurns = Math.min(
      next.completion.maxTurns,
      Math.max(1, Math.trunc(Number(policy.maxTurns))),
    )
  if (policy.sandbox) {
    const sandboxKey = defineConfigKey<AgentDefinition['sandbox']>({
      id: `agentDefinitions.${definition.name}.sandbox`,
      builtin: next.sandbox,
      merge: (current, candidate) => ({
        filesystem: stricterFilesystem(
          current.filesystem,
          candidate.value.filesystem,
        ),
        network: stricterExecutionPolicy(
          current.network,
          candidate.value.network,
        ),
        process: stricterExecutionPolicy(
          current.process,
          candidate.value.process,
        ),
      }),
    })
    next.sandbox = new ConfigResolver().resolve(sandboxKey, {
      candidates: [
        {
          source: {
            kind: 'session',
            id: `agent-session:${definition.name}`,
            trust: 'trusted',
          },
          value: { ...next.sandbox, ...policy.sandbox },
        },
      ],
    }).value
  }
  return next
}

function resolveSource(
  input: ExtensionSourceInput,
  diagnostics: ExtensionDiagnostic[],
): ExtensionSourceSnapshot {
  const rank = SOURCE_PRECEDENCE[input.kind]
  const root = resolve(String(input.root ?? ''))
  const inputManifests = Array.isArray(input.manifests) ? input.manifests : []
  const manifests = Array.isArray(input.manifests)
    ? input.manifests.slice(0, MAX_MANIFESTS_PER_SOURCE).map(String)
    : []
  const sourceIdValid = RESOURCE_ID_RE.test(String(input.id ?? '').trim())
  const trust = sourceTrust(input)
  const blockedReason = sourceBlockedReason(input)
  let canonicalRoot = root
  let filesystemError: string | null = null
  try {
    const stat = lstatSync(root)
    if (stat.isSymbolicLink()) filesystemError = 'source_root_symlink'
    else if (!stat.isDirectory()) filesystemError = 'source_root_not_directory'
    else canonicalRoot = realpathSync(root)
  } catch {
    filesystemError = 'source_root_missing'
  }
  const source: ExtensionSourceSnapshot = {
    id: safeSourceId(input.id),
    identity: '',
    kind: input.kind,
    rank,
    trust: filesystemError ? 'untrusted' : trust,
    canonicalRoot,
    manifests,
    readOnly:
      input.readOnly ?? (input.kind === 'builtin' || input.kind === 'managed'),
    active:
      sourceIdValid &&
      !blockedReason &&
      !filesystemError &&
      manifests.length > 0,
    blockedReason:
      (sourceIdValid ? null : 'invalid_source_id') ??
      blockedReason ??
      filesystemError ??
      (manifests.length ? null : 'no_manifests'),
  }
  source.identity = digest({
    id: source.id,
    kind: source.kind,
    canonicalRoot: source.canonicalRoot,
  })
  if (source.blockedReason) {
    diagnostics.push(
      diagnostic(
        source.blockedReason,
        source,
        '.',
        null,
        sourceBlockedMessage(source.blockedReason),
      ),
    )
  }
  if (inputManifests.length > MAX_MANIFESTS_PER_SOURCE) {
    diagnostics.push(
      diagnostic(
        'manifest_limit_exceeded',
        source,
        '.',
        null,
        `Only the first ${MAX_MANIFESTS_PER_SOURCE} manifests were considered.`,
      ),
    )
  }
  return source
}

function sourceTrust(input: ExtensionSourceInput): ExtensionTrust {
  if (input.kind === 'builtin') return 'system'
  if (input.kind === 'managed')
    return input.trusted === true ? 'managed' : 'untrusted'
  if (input.kind === 'user') return 'user'
  if (input.kind === 'project')
    return input.trusted === true ? 'project' : 'untrusted'
  return input.trusted === true && input.signatureVerified === true
    ? 'verified_plugin'
    : 'untrusted'
}

function sourceBlockedReason(input: ExtensionSourceInput): string | null {
  if (input.kind === 'project' && input.trusted !== true)
    return 'project_untrusted'
  if (input.kind === 'plugin' && input.signatureVerified !== true)
    return 'plugin_signature_unverified'
  if (input.kind === 'plugin' && input.trusted !== true)
    return 'plugin_untrusted'
  if (input.kind === 'managed' && input.trusted !== true)
    return 'managed_source_untrusted'
  return null
}

function containedRegularFile(opts: {
  source: ExtensionSourceSnapshot
  base: string
  requested: string
  label: 'manifest' | 'prompt'
  maxBytes: number
  diagnostics: ExtensionDiagnostic[]
  agentName?: string | null
}): string | null {
  const requested = String(opts.requested ?? '').trim()
  const traversal =
    !requested ||
    isAbsolute(requested) ||
    win32.isAbsolute(requested) ||
    requested.split(/[\\/]+/).some((part) => part === '..')
  if (traversal) {
    opts.diagnostics.push(
      diagnostic(
        `${opts.label}_path_traversal`,
        opts.source,
        safeDiagnosticPath(requested),
        opts.agentName ?? null,
        `${capitalize(opts.label)} path must be relative and contained by its source root.`,
      ),
    )
    return null
  }
  const path = resolve(opts.base, requested)
  if (!isContained(opts.source.canonicalRoot, path)) {
    opts.diagnostics.push(
      diagnostic(
        `${opts.label}_path_traversal`,
        opts.source,
        safeDiagnosticPath(requested),
        opts.agentName ?? null,
        `${capitalize(opts.label)} path escapes its source root.`,
      ),
    )
    return null
  }
  let canonical: string
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      opts.diagnostics.push(
        diagnostic(
          `${opts.label}_symlink_rejected`,
          opts.source,
          safeDiagnosticPath(requested),
          opts.agentName ?? null,
          `${capitalize(opts.label)} must not be a symbolic link.`,
        ),
      )
      return null
    }
    if (!stat.isFile()) throw new Error('not a regular file')
    if (stat.size > opts.maxBytes) {
      opts.diagnostics.push(
        diagnostic(
          `${opts.label}_size_exceeded`,
          opts.source,
          safeDiagnosticPath(requested),
          opts.agentName ?? null,
          `${capitalize(opts.label)} exceeds the bounded size limit.`,
        ),
      )
      return null
    }
    canonical = realpathSync(path)
  } catch {
    opts.diagnostics.push(
      diagnostic(
        `${opts.label}_unavailable`,
        opts.source,
        safeDiagnosticPath(requested),
        opts.agentName ?? null,
        `${capitalize(opts.label)} is missing or is not a regular file.`,
      ),
    )
    return null
  }
  if (!isContained(opts.source.canonicalRoot, canonical)) {
    opts.diagnostics.push(
      diagnostic(
        `${opts.label}_path_traversal`,
        opts.source,
        safeDiagnosticPath(requested),
        opts.agentName ?? null,
        `${capitalize(opts.label)} canonical path escapes its source root.`,
      ),
    )
    return null
  }
  return canonical
}

function readBundle(
  manifestPath: string,
  source: ExtensionSourceSnapshot,
  relativePath: string,
  diagnostics: ExtensionDiagnostic[],
): z.infer<typeof agentBundleSchema> | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    diagnostics.push(
      diagnostic(
        'invalid_manifest_json',
        source,
        safeDiagnosticPath(relativePath),
        null,
        'Extension manifest is not valid JSON.',
      ),
    )
    return null
  }
  const parsed = agentBundleSchema.safeParse(raw)
  if (!parsed.success) {
    diagnostics.push(
      diagnostic(
        'invalid_manifest_schema',
        source,
        safeDiagnosticPath(relativePath),
        null,
        `Extension manifest schema is invalid at ${safeIssuePath(parsed.error)}.`,
      ),
    )
    return null
  }
  return parsed.data
}

function compareSources(
  left: ExtensionSourceSnapshot,
  right: ExtensionSourceSnapshot,
): number {
  return right.rank - left.rank || left.id.localeCompare(right.id)
}

function compareCandidates(
  left: AgentCandidate,
  right: AgentCandidate,
): number {
  return (
    right.source.rank - left.source.rank ||
    left.source.id.localeCompare(right.source.id) ||
    left.order - right.order
  )
}

function sourceRevisionInput(source: ExtensionSourceSnapshot): unknown {
  return {
    identity: source.identity,
    rank: source.rank,
    trust: source.trust,
    active: source.active,
    blockedReason: source.blockedReason,
    manifests: source.manifests,
  }
}

function diagnostic(
  code: string,
  source: Pick<ExtensionSourceSnapshot, 'id'>,
  path: string,
  agentName: string | null,
  message: string,
): ExtensionDiagnostic {
  return {
    code,
    severity: 'error',
    sourceId: source.id,
    path: safeDiagnosticPath(path),
    agentName,
    message,
  }
}

function safeIssuePath(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue || issue.path.length === 0) return '<root>'
  return issue.path.map(String).join('.')
}

function safeAgentName(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const name = (value as Record<string, unknown>).name
  return typeof name === 'string' && AGENT_NAME_RE.test(name) ? name : null
}

function safeSourceId(value: unknown): string {
  const text = String(value ?? '').trim()
  return RESOURCE_ID_RE.test(text)
    ? text
    : `invalid-${digest(text).slice(0, 12)}`
}

function safeDiagnosticPath(value: string): string {
  const text = String(value ?? '').trim()
  if (!text) return '.'
  return text.length > 512 ? `${text.slice(0, 509)}...` : text
}

function sourceBlockedMessage(reason: string): string {
  const messages: Record<string, string> = {
    project_untrusted: 'Project extension source is not trusted.',
    plugin_signature_unverified:
      'Plugin extension source does not have a verified package signature.',
    plugin_untrusted: 'Plugin extension source is not trusted.',
    managed_source_untrusted: 'Managed extension source is not trusted.',
    source_root_symlink: 'Extension source root must not be a symbolic link.',
    source_root_not_directory: 'Extension source root is not a directory.',
    source_root_missing: 'Extension source root is unavailable.',
    no_manifests: 'Extension source declares no manifests.',
    invalid_source_id: 'Extension source id is invalid.',
  }
  return messages[reason] ?? 'Extension source is inactive.'
}

function restrictOpenAllowList(
  base: string[],
  requested: string[] | undefined,
): string[] {
  if (requested === undefined) return [...base]
  const clean = normalizeRestriction(requested)
  if (base.length === 0) return clean
  return restrictAllowList(base, clean)
}

function restrictAllowList(
  base: readonly string[],
  requested: readonly string[] | undefined,
): string[] {
  if (requested === undefined) return [...base]
  const clean = normalizeRestriction(requested)
  if (clean.includes('*')) return [...base]
  if (base.includes('*')) return clean
  const requestedSet = new Set(clean)
  return base.filter((item) => requestedSet.has(item))
}

function normalizeRestriction(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((item) => String(item).trim())
        .filter((item) => item === '*' || RESOURCE_ID_RE.test(item)),
    ),
  ]
}

function stricterMemoryMode(
  base: AgentMemoryMode,
  requested: AgentMemoryMode,
): AgentMemoryMode {
  const order: AgentMemoryMode[] = ['none', 'read', 'read-write']
  return order[Math.min(order.indexOf(base), order.indexOf(requested))]!
}

function stricterFilesystem(
  base: AgentFilesystemPolicy,
  requested: AgentFilesystemPolicy,
): AgentFilesystemPolicy {
  return base === 'read-only' || requested === 'read-only'
    ? 'read-only'
    : 'workspace-write'
}

function stricterExecutionPolicy(
  base: AgentExecutionPolicy,
  requested: AgentExecutionPolicy,
): AgentExecutionPolicy {
  return base === 'deny' || requested === 'deny' ? 'deny' : 'policy'
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function uniqueValues(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function digest(value: unknown): string {
  const input = typeof value === 'string' ? value : stableJson(value)
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    )
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sortRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  Object.freeze(value)
  for (const item of Object.values(value as Record<string, unknown>))
    deepFreeze(item)
  return value
}
