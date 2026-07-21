import { createHash } from 'node:crypto'

/**
 * Shared configuration layers. Their numeric rank is deliberately independent
 * from input order: managed policy is applied last so a session or project
 * cannot undo an administrator deny/require constraint.
 */
export const CONFIG_LAYER_PRECEDENCE = {
  builtin: 100,
  user: 300,
  project: 400,
  session: 450,
  managed: 500,
} as const

export type ConfigLayerKind = keyof typeof CONFIG_LAYER_PRECEDENCE
export type ConfigSourceTrust = 'trusted' | 'untrusted' | 'managed'

export interface ConfigSource {
  kind: ConfigLayerKind
  id: string
  trust: ConfigSourceTrust
}

export interface ConfigCandidate<T> {
  source: ConfigSource
  value: T
  active?: boolean
}

export interface ConfigMergeContext<T> {
  key: ConfigKey<T>
  source: ConfigSource
}

export interface ConfigKey<T> {
  id: string
  builtin: T
  secretPaths: readonly string[]
  restrictUntrustedProject: ConfigKey<T>['merge'] | null
  merge: (
    current: Readonly<T>,
    next: Readonly<ConfigCandidate<T>>,
    context: ConfigMergeContext<T>,
  ) => T
}

export interface ConfigTraceEntry {
  source: ConfigSource
  status: 'applied' | 'rejected'
  reason: string
  fingerprint: string
}

export interface Resolved<T> {
  key: ConfigKey<T>
  value: T
  source: ConfigSource
  trust: ConfigSourceTrust
  overridden: readonly ConfigCandidate<T>[]
  trace: readonly ConfigTraceEntry[]
  secretSources: ReadonlyArray<{ path: string; source: ConfigSource }>
}

export interface ConfigContext<T> {
  candidates?: readonly ConfigCandidate<T>[]
}

export interface ConfigKeyOptions<T> {
  id: string
  builtin: T
  secretPaths?: readonly string[]
  restrictUntrustedProject?: ConfigKey<T>['merge']
  merge?: ConfigKey<T>['merge']
}

export interface EffectiveConfigEntry {
  key: string
  value: unknown
  source: ConfigSource
  trust: ConfigSourceTrust
  trace: ConfigTraceEntry[]
  secretSources: Array<{ path: string; source: ConfigSource }>
}

export interface EffectiveConfigSnapshot {
  schemaVersion: 1
  revision: string
  entries: EffectiveConfigEntry[]
}

export function defineConfigKey<T>(options: ConfigKeyOptions<T>): ConfigKey<T> {
  const id = String(options.id ?? '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id))
    throw new Error(`Invalid config key: ${id}`)
  const secretPaths = [...new Set(options.secretPaths ?? [])]
    .map((path) => String(path).trim())
    .filter(Boolean)
    .sort()
  return Object.freeze({
    id,
    builtin: cloneValue(options.builtin),
    secretPaths,
    restrictUntrustedProject: options.restrictUntrustedProject ?? null,
    merge:
      options.merge ??
      ((_current: Readonly<T>, next: Readonly<ConfigCandidate<T>>) =>
        cloneValue(next.value)),
  })
}

export class ConfigResolver {
  resolve<T>(key: ConfigKey<T>, context: ConfigContext<T> = {}): Resolved<T> {
    const builtinSource: ConfigSource = {
      kind: 'builtin',
      id: `${key.id}:builtin`,
      trust: 'trusted',
    }
    let value = cloneValue(key.builtin)
    let source = builtinSource
    const applied: ConfigCandidate<T>[] = [
      { source: builtinSource, value: cloneValue(key.builtin) },
    ]
    const trace: ConfigTraceEntry[] = [
      traceEntry(key, applied[0]!, 'applied', 'builtin_default'),
    ]
    const secretSources = new Map<string, ConfigSource>()
    for (const path of key.secretPaths) {
      if (containsSecretPath(key.builtin, path))
        secretSources.set(path, { ...builtinSource })
    }
    const candidates = [...(context.candidates ?? [])].sort(compareCandidates)

    for (const raw of candidates) {
      const candidate = cloneCandidate(raw)
      const invalidReason = invalidSourceReason(candidate.source)
      if (candidate.active === false) {
        trace.push(traceEntry(key, candidate, 'rejected', 'inactive_source'))
        continue
      }
      if (invalidReason) {
        trace.push(traceEntry(key, candidate, 'rejected', invalidReason))
        continue
      }
      const untrustedProject =
        candidate.source.kind === 'project' &&
        candidate.source.trust === 'untrusted'
      if (untrustedProject && !key.restrictUntrustedProject) {
        trace.push(
          traceEntry(
            key,
            candidate,
            'rejected',
            'untrusted_project_cannot_replace',
          ),
        )
        continue
      }
      const merge = untrustedProject ? key.restrictUntrustedProject! : key.merge
      const merged = cloneValue(
        merge(value, candidate, {
          key,
          source: candidate.source,
        }),
      )
      if (untrustedProject && stableJson(merged) === stableJson(value)) {
        trace.push(
          traceEntry(
            key,
            candidate,
            'rejected',
            'untrusted_project_not_tightening',
          ),
        )
        continue
      }
      value = merged
      source = { ...candidate.source }
      applied.push(candidate)
      if (!untrustedProject)
        for (const path of key.secretPaths) {
          if (containsSecretPath(candidate.value, path))
            secretSources.set(path, { ...candidate.source })
        }
      trace.push(
        traceEntry(
          key,
          candidate,
          'applied',
          untrustedProject ? 'untrusted_project_restriction' : 'layer_merged',
        ),
      )
    }

    return {
      key,
      value,
      source,
      trust: source.trust,
      overridden: applied.slice(0, -1),
      trace,
      secretSources: [...secretSources.entries()].map(([path, owner]) => ({
        path,
        source: owner,
      })),
    }
  }
}

export function effectiveConfigSnapshot(
  resolutions: readonly Resolved<any>[],
): EffectiveConfigSnapshot {
  const entries = resolutions
    .map(effectiveEntry)
    .sort((left, right) => left.key.localeCompare(right.key))
  return {
    schemaVersion: 1,
    revision: digest(entries),
    entries,
  }
}

function effectiveEntry(resolved: Resolved<any>): EffectiveConfigEntry {
  const value = redactConfigValue(resolved.value, resolved.key.secretPaths)
  return {
    key: resolved.key.id,
    value,
    source: { ...resolved.source },
    trust: resolved.trust,
    trace: resolved.trace.map((entry) => ({
      ...entry,
      source: { ...entry.source },
    })),
    secretSources: resolved.secretSources.map((item) => ({
      path: item.path,
      source: { ...item.source },
    })),
  }
}

export function redactConfigValue(
  value: unknown,
  secretPaths: readonly string[],
): unknown {
  const patterns = secretPaths.map((path) => path.split('.'))
  return redactAt(value, [], patterns)
}

function redactAt(
  value: unknown,
  path: string[],
  patterns: string[][],
): unknown {
  if (patterns.some((pattern) => matchesPath(path, pattern)))
    return '[REDACTED]'
  if (Array.isArray(value))
    return value.map((item, index) =>
      redactAt(item, [...path, String(index)], patterns),
    )
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = redactAt(
        (value as Record<string, unknown>)[key],
        [...path, key],
        patterns,
      )
    }
    return out
  }
  return value
}

function matchesPath(path: string[], pattern: string[]): boolean {
  return (
    path.length === pattern.length &&
    path.every(
      (part, index) => pattern[index] === '*' || pattern[index] === part,
    )
  )
}

function containsSecretPath(value: unknown, pattern: string): boolean {
  return containsAt(value, pattern.split('.'), 0)
}

function containsAt(value: unknown, pattern: string[], index: number): boolean {
  if (index === pattern.length) return true
  if (!value || typeof value !== 'object') return false
  const part = pattern[index]!
  if (part === '*')
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsAt(item, pattern, index + 1),
    )
  if (!Object.prototype.hasOwnProperty.call(value, part)) return false
  return containsAt(
    (value as Record<string, unknown>)[part],
    pattern,
    index + 1,
  )
}

function compareCandidates<T>(
  left: ConfigCandidate<T>,
  right: ConfigCandidate<T>,
): number {
  return (
    CONFIG_LAYER_PRECEDENCE[left.source.kind] -
      CONFIG_LAYER_PRECEDENCE[right.source.kind] ||
    right.source.id.localeCompare(left.source.id)
  )
}

function invalidSourceReason(source: ConfigSource): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(source.id))
    return 'invalid_source_id'
  if (source.kind === 'managed' && source.trust !== 'managed')
    return 'managed_source_not_verified'
  if (source.kind !== 'managed' && source.trust === 'managed')
    return 'managed_trust_kind_mismatch'
  if (source.trust === 'untrusted' && source.kind !== 'project')
    return 'untrusted_source_not_allowed'
  return null
}

function traceEntry<T>(
  key: ConfigKey<T>,
  candidate: ConfigCandidate<T>,
  status: ConfigTraceEntry['status'],
  reason: string,
): ConfigTraceEntry {
  return {
    source: { ...candidate.source },
    status,
    reason,
    fingerprint: digest(redactConfigValue(candidate.value, key.secretPaths)),
  }
}

function cloneCandidate<T>(candidate: ConfigCandidate<T>): ConfigCandidate<T> {
  return {
    source: { ...candidate.source },
    value: cloneValue(candidate.value),
    ...(candidate.active === undefined ? {} : { active: candidate.active }),
  }
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(jsonSafe(value)))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[key] = jsonSafe(item)
    return out
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value
  return String(value)
}
