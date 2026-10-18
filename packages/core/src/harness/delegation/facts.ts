import { createHash } from 'node:crypto'
import { validPng } from './image-proof'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { durableReplaceSync } from '../../store/persistence'
import type {
  ExecutorProfile,
  ExecutorProbe,
  ExecutorRuntimeFacts,
  NormalizedExecutorEvent,
  NativeCapabilityEvidence,
} from './types'

export const EXECUTOR_TOOL_POLICY = 'native-tools-v2-structured-results'
export const CLAUDE_HOST_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Bash',
  'AskUserQuestion',
  'WebSearch',
  'WebFetch',
]
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = (p: ExecutorProfile) =>
  digest({
    id: p.id,
    backend: p.backend,
    path: p.executablePath,
    version: p.expectedVersion,
    model: p.defaultModel ?? null,
    auth: p.authRef,
    policy: EXECUTOR_TOOL_POLICY,
  })
interface Stored {
  profileId: string
  key: string
  identity: string
  facts: ExecutorRuntimeFacts
}
export interface FactContext {
  cwd: string
  runId: string
  delegationId: string
  permissionMode?: string
  nativeImageRoot?: string
}
const empty = (p: ExecutorProfile): ExecutorRuntimeFacts => ({
  configuredModel: p.defaultModel ?? null,
  reportedModel: null,
  modelSource: null,
  provider: null,
  hostAllowedTools:
    p.backend === 'claude-code'
      ? [...CLAUDE_HOST_TOOLS]
      : ['commandExecution', 'fileChange', 'webSearch', 'imageGeneration'],
  advertisedTools: null,
  observedTools: [],
  searchMode: p.backend === 'codex' ? 'live' : 'unknown',
  nativeCapabilities: {
    search: { status: 'unverified' },
    imageGeneration: {
      status: p.backend === 'claude-code' ? 'unsupported' : 'unverified',
      ...(p.backend === 'claude-code'
        ? {
            reason:
              'Current host tool policy exposes no native image generator',
          }
        : {}),
    },
  },
})
const clean = (s: unknown): string | null =>
  typeof s === 'string' && s.length > 0 ? s.slice(0, 256) : null
/** Persist public source URLs only; never credentials, query strings or fragments. */
export function publicReferences(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [
    ...new Set(
      values.flatMap((value) => {
        try {
          const u = new URL(String(value))
          return ['https:', 'http:'].includes(u.protocol) &&
            !u.username &&
            !u.password
            ? [u.origin + u.pathname]
            : []
        } catch {
          return []
        }
      }),
    ),
  ].slice(0, 24)
}
function imageReference(
  path: string,
  roots: string[],
  verify: (bytes: Buffer) => boolean,
): string | undefined {
  try {
    const actual = realpathSync(path)
    if (
      !roots.some((root) => {
        try {
          const local = relative(realpathSync(root), actual)
          return (
            !isAbsolute(local) &&
            local !== '..' &&
            !local.startsWith('..' + sep)
          )
        } catch {
          return false
        }
      }) ||
      !statSync(actual).isFile() ||
      statSync(actual).size > 32 * 1024 * 1024
    )
      return
    const b = readFileSync(actual)
    return verify(b) ? actual : undefined
  } catch {
    return
  }
}
/** Core owns this store under the desktop lifetime state-root writer lock. */
export class ExecutorFactsStore {
  readonly file: string
  private rows: Record<string, Stored> = {}
  private identities = new Map<string, string>()
  private probes = new Map<string, { key: string; probe: ExecutorProbe }>()
  private rounds = new Map<
    string,
    { search: boolean; fetch: boolean; references: string[] }
  >()
  private runs = new Map<
    string,
    { key: string; identity: string; model: string | null }
  >()
  private damaged = false
  constructor(
    root: string,
    private readonly verifyImage: (bytes: Buffer) => boolean = validPng,
  ) {
    this.file = join(root, 'runtime-facts.json')
    if (existsSync(this.file))
      try {
        const data = JSON.parse(readFileSync(this.file, 'utf8'))
        if (
          data.schemaVersion !== 1 ||
          !data.rows ||
          typeof data.rows !== 'object' ||
          Array.isArray(data.rows)
        )
          throw Error('unsupported facts')
        for (const r of Object.values(data.rows) as Stored[])
          if (
            !r ||
            typeof r.key !== 'string' ||
            typeof r.identity !== 'string' ||
            !r.facts?.nativeCapabilities?.search ||
            !r.facts?.nativeCapabilities?.imageGeneration
          )
            throw Error('damaged facts')
        this.rows = data.rows
      } catch {
        this.damaged = true
      }
  }
  private save() {
    if (!this.damaged)
      durableReplaceSync(
        this.file,
        JSON.stringify({ schemaVersion: 1, rows: this.rows }, null, 2) + '\n',
      )
  }
  bind(
    profile: ExecutorProfile,
    environment: Record<string, string>,
    runId?: string,
  ) {
    let account: unknown = environment.OPENAI_API_KEY ?? null
    if (profile.backend === 'codex' && !account && environment.CODEX_HOME)
      try {
        const auth = JSON.parse(
          readFileSync(join(environment.CODEX_HOME, 'auth.json'), 'utf8'),
        )
        account =
          auth.OPENAI_API_KEY ??
          auth.tokens?.account_id ??
          auth.tokens?.id_token ??
          null
      } catch {
        /* identity remains unknown */
      }
    const identity = digest({
      account:
        profile.backend === 'codex'
          ? account
          : (environment.ANTHROPIC_API_KEY ??
            environment.ANTHROPIC_AUTH_TOKEN ??
            environment.CLAUDE_CODE_OAUTH_TOKEN ??
            null),
      provider:
        environment.ANTHROPIC_BASE_URL ??
        environment.OPENAI_BASE_URL ??
        'native',
      model: profile.defaultModel ?? environment.ANTHROPIC_MODEL ?? null,
    })
    this.identities.set(key(profile), identity)
    if (runId && !this.runs.has(runId))
      this.runs.set(runId, { key: key(profile), identity, model: null })
    const row = this.rows[key(profile)]
    if (row && row.identity === identity)
      row.facts.configuredModel =
        profile.defaultModel ?? environment.ANTHROPIC_MODEL ?? null
    if (!row) {
      const prior = Object.values(this.rows)
          .filter((r) => r.profileId === profile.id)
          .at(-1),
        facts = empty(profile)
      facts.configuredModel =
        profile.defaultModel ?? environment.ANTHROPIC_MODEL ?? null
      if (prior)
        for (const kind of ['search', 'imageGeneration'] as const)
          if (
            prior.facts.nativeCapabilities[kind].status !== 'unverified' &&
            prior.facts.nativeCapabilities[kind].status !== 'unsupported'
          )
            facts.nativeCapabilities[kind] = {
              ...prior.facts.nativeCapabilities[kind],
              status: 'stale',
            }
      this.rows[key(profile)] = {
        profileId: profile.id,
        key: key(profile),
        identity,
        facts,
      }
      this.save()
    }
  }
  setProbe(profile: ExecutorProfile, probe: ExecutorProbe) {
    this.probes.set(profile.id, { key: key(profile), probe })
  }
  probe(profile: ExecutorProfile) {
    const p = this.probes.get(profile.id)
    return p?.key === key(profile) ? p.probe : null
  }
  view(profile: ExecutorProfile): ExecutorRuntimeFacts {
    if (this.damaged) return empty(profile)
    const row = this.rows[key(profile)]
    if (!row) return empty(profile)
    const facts = structuredClone(row.facts)
    const probe = this.probe(profile)
    if (probe && probe.status !== 'available')
      for (const c of Object.values(facts.nativeCapabilities))
        if (c.status === 'available') c.status = 'stale'
    if (this.identities.get(key(profile)) !== row.identity) {
      for (const c of Object.values(facts.nativeCapabilities))
        if (c.status !== 'unsupported' && c.status !== 'unverified')
          c.status = 'stale'
      facts.reportedModel = null
      facts.modelSource = null
      facts.provider = null
      facts.advertisedTools = null
      facts.observedTools = []
    }
    return facts
  }
  observe(
    profile: ExecutorProfile,
    context: FactContext,
    event: NormalizedExecutorEvent,
  ) {
    if (this.damaged) return
    const identity = this.identities.get(key(profile))
    if (!identity) return
    let binding = this.runs.get(context.runId)
    if (!binding) {
      binding = { key: key(profile), identity, model: null }
      this.runs.set(context.runId, binding)
    }
    // Authentication/model provenance belongs to a run, never to whichever
    // sibling most recently updated the shared profile summary.
    if (binding.key !== key(profile) || binding.identity !== identity) {
      if (event.type === 'turn_finished') {
        this.runs.delete(context.runId)
        this.rounds.delete(context.runId)
      }
      return
    }
    let row = this.rows[key(profile)]
    if (!row || row.identity !== identity)
      this.rows[key(profile)] = row = {
        profileId: profile.id,
        key: key(profile),
        identity,
        facts: empty(profile),
      }
    const f = row.facts,
      now = Date.now()
    if (event.type === 'runtime_metadata') {
      const reported = clean(event.model)
      if (reported && binding.model !== reported) {
        this.rounds.delete(context.runId)
        binding.model = reported
      }
      const lowerPriority =
        event.source === 'initialization' &&
        f.modelSource === 'provider-response'
      if (
        !lowerPriority &&
        event.model &&
        f.reportedModel &&
        f.reportedModel !== event.model
      ) {
        for (const c of Object.values(f.nativeCapabilities))
          if (c.status !== 'unsupported' && c.status !== 'unverified')
            c.status = 'stale'
        this.rounds.delete(context.runId)
      }
      if (!lowerPriority) {
        f.reportedModel = clean(event.model) ?? f.reportedModel
        f.modelSource = clean(event.source)
      }
      f.provider = clean(event.provider) ?? f.provider
      if (event.advertisedTools)
        f.advertisedTools = event.advertisedTools
          .filter((t) => typeof t === 'string')
          .slice(0, 128)
          .map((t) => t.slice(0, 128))
      if (event.searchMode) f.searchMode = event.searchMode
      f.observedAt = now
    }
    if (event.type === 'tool_started')
      f.observedTools = [...new Set([...f.observedTools, event.name])].slice(
        0,
        128,
      )
    if (event.type === 'tool_finished' && event.evidence) {
      if (binding.model !== f.reportedModel) return
      const e = event.evidence,
        kind = e.kind === 'search' ? 'search' : 'imageGeneration'
      if (f.nativeCapabilities[kind].status === 'unsupported') return
      const refs = publicReferences(e.references)
      const proof: NativeCapabilityEvidence = {
        status: 'unavailable',
        checkedAt: now,
        runId: context.runId,
        delegationId: context.delegationId,
        model: binding.model,
        backend: profile.backend,
        executorVersion:
          this.probe(profile)?.executableVersion ?? profile.expectedVersion,
        adapterVersion: 'native-facts-v2',
        toolPolicy: EXECUTOR_TOOL_POLICY,
        permissionMode: context.permissionMode,
        authIdentity: binding.identity.slice(0, 12),
        references: refs,
        ...(e.kind === 'search'
          ? { searchMode: e.searchMode ?? f.searchMode }
          : {}),
      }
      if (e.verified === false) {
        proof.status = 'unverified'
        proof.reason =
          'Native protocol supplied activity without affirmative result evidence'
      } else if (e.kind === 'image-generation' && e.success && e.artifactPath) {
        const path = imageReference(
          e.artifactPath,
          [
            context.cwd,
            ...(context.nativeImageRoot ? [context.nativeImageRoot] : []),
          ],
          this.verifyImage,
        )
        if (path) {
          proof.status = 'available'
          proof.references = [path]
        } else
          proof.reason =
            'Native image output is missing, invalid or outside its workspace'
      } else if (
        e.kind === 'search' &&
        e.success &&
        (e.action === 'search' || refs.length)
      ) {
        const round = this.rounds.get(context.runId) ?? {
          search: false,
          fetch: false,
          references: [],
        }
        round[e.action === 'fetch' ? 'fetch' : 'search'] = true
        round.references = [...new Set([...round.references, ...refs])].slice(
          0,
          24,
        )
        this.rounds.set(context.runId, round)
        proof.status = round.search && round.fetch ? 'available' : 'verifying'
        proof.references = round.references
      } else {
        proof.reason =
          'Native tool did not produce a successful verifiable result'
        this.rounds.delete(context.runId)
      }
      f.nativeCapabilities[kind] = proof
    }
    if (event.type === 'turn_finished') {
      for (const c of Object.values(f.nativeCapabilities))
        if (c.runId === context.runId && c.status === 'verifying') {
          c.status = 'unverified'
          c.reason =
            'Native search and page retrieval were not both proven in this run'
        }
      this.rounds.delete(context.runId)
      this.runs.delete(context.runId)
    }
    if (
      event.type === 'runtime_metadata' ||
      event.type === 'tool_started' ||
      event.type === 'tool_finished' ||
      event.type === 'turn_finished'
    )
      this.save()
  }
}
