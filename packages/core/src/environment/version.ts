export type VersionRequirementStatus = 'supported' | 'unsupported' | 'invalid'

export interface VersionRequirementResult {
  status: VersionRequirementStatus
  raw: string
  normalized: string | null
  reason: string | null
}

export interface VersionRequirementOptions {
  allowStable?: boolean
  fallbackVersion?: string | null
}

interface NumericVersion {
  parts: number[]
  componentCount: number
}

interface Predicate {
  operator: '=' | '>' | '>=' | '<' | '<='
  version: number[]
}

export function normalizeDetectedVersion(value: string): string | null {
  const parsed = parseNumericVersion(value)
  return parsed ? formatVersion(parsed.parts) : null
}

export function parseVersionRequirement(
  value: string,
  opts: VersionRequirementOptions = {},
): VersionRequirementResult {
  const raw = String(value ?? '').trim()
  if (!raw)
    return { status: 'invalid', raw, normalized: null, reason: 'empty' }
  if (raw.length > 512)
    return {
      status: 'invalid',
      raw: raw.slice(0, 512),
      normalized: null,
      reason: 'requirement_too_long',
    }
  if (raw.toLowerCase() === 'stable') {
    if (!opts.allowStable)
      return {
        status: 'unsupported',
        raw,
        normalized: null,
        reason: 'stable_channel_not_allowed',
      }
    const fallback = normalizeDetectedVersion(opts.fallbackVersion ?? '')
    return fallback
      ? {
          status: 'supported',
          raw,
          normalized: `=${fallback}`,
          reason: null,
        }
      : {
          status: 'unsupported',
          raw,
          normalized: null,
          reason: 'stable_channel_has_no_pinned_fallback',
        }
  }
  if (/\|\||\*|\bx\b|\blts\b/i.test(raw))
    return {
      status: 'unsupported',
      raw,
      normalized: null,
      reason: 'unsupported_range_syntax',
    }

  const tokens = raw
    .replaceAll(',', ' ')
    .split(/\s+/)
    .filter(Boolean)
  const predicates: Predicate[] = []
  for (const token of tokens) {
    const parsed = parseRequirementToken(token)
    if (!parsed)
      return {
        status: 'invalid',
        raw,
        normalized: null,
        reason: 'invalid_range_syntax',
      }
    predicates.push(...parsed)
  }
  if (!predicates.length)
    return { status: 'invalid', raw, normalized: null, reason: 'empty' }
  if (!hasSatisfyingVersion(predicates))
    return {
      status: 'invalid',
      raw,
      normalized: null,
      reason: 'unsatisfiable_range',
    }
  return {
    status: 'supported',
    raw,
    normalized: predicates
      .map((item) => `${item.operator}${formatVersion(item.version)}`)
      .join(' '),
    reason: null,
  }
}

export function versionSatisfies(
  version: string,
  requirement: string,
  opts: VersionRequirementOptions = {},
): boolean {
  const actual = parseNumericVersion(version)
  const parsed = parseVersionRequirement(requirement, opts)
  if (!actual || parsed.status !== 'supported' || !parsed.normalized)
    return false
  return parsed.normalized.split(' ').every((token) => {
    const match = /^(<=|>=|<|>|=)(\d+(?:\.\d+){2,3})$/.exec(token)
    if (!match) return false
    const expected = parseNumericVersion(match[2]!)
    if (!expected) return false
    const comparison = compareVersions(actual.parts, expected.parts)
    if (match[1] === '<') return comparison < 0
    if (match[1] === '<=') return comparison <= 0
    if (match[1] === '>') return comparison > 0
    if (match[1] === '>=') return comparison >= 0
    return comparison === 0
  })
}

function parseRequirementToken(token: string): Predicate[] | null {
  const match = /^(<=|>=|<|>|=|\^|~)?(?:v|go)?(\d+(?:\.\d+){0,3})$/i.exec(
    token,
  )
  if (!match) return null
  const parsed = parseNumericVersion(match[2]!)
  if (!parsed) return null
  const operator = match[1] ?? ''
  const lower = padVersion(parsed.parts)
  if (!operator && parsed.componentCount < 3)
    return partialRange(lower, parsed.componentCount)
  if (!operator || operator === '=') return [{ operator: '=', version: lower }]
  if (operator === '^') return compatibleRange(lower)
  if (operator === '~') return tildeRange(lower, parsed.componentCount)
  return [{ operator: operator as Predicate['operator'], version: lower }]
}

function parseNumericVersion(value: string): NumericVersion | null {
  const match = /^(?:v|go)?(\d+(?:\.\d+){0,3})$/i.exec(String(value).trim())
  if (!match) return null
  const parts = match[1]!.split('.').map(Number)
  if (
    parts.some(
      (part) => !Number.isSafeInteger(part) || part < 0 || part > 999_999_999,
    )
  )
    return null
  return { parts, componentCount: parts.length }
}

function partialRange(version: number[], components: number): Predicate[] {
  const upper = [...version]
  if (components === 1) {
    upper[0] = (upper[0] ?? 0) + 1
    upper[1] = 0
  } else {
    upper[1] = (upper[1] ?? 0) + 1
  }
  upper[2] = 0
  return [
    { operator: '>=', version },
    { operator: '<', version: upper },
  ]
}

function compatibleRange(version: number[]): Predicate[] {
  const upper = [...version]
  if ((upper[0] ?? 0) > 0) {
    upper[0] = (upper[0] ?? 0) + 1
    upper[1] = 0
    upper[2] = 0
  } else if ((upper[1] ?? 0) > 0) {
    upper[1] = (upper[1] ?? 0) + 1
    upper[2] = 0
  } else upper[2] = (upper[2] ?? 0) + 1
  return [
    { operator: '>=', version },
    { operator: '<', version: upper },
  ]
}

function tildeRange(version: number[], components: number): Predicate[] {
  const upper = [...version]
  if (components === 1) {
    upper[0] = (upper[0] ?? 0) + 1
    upper[1] = 0
  } else upper[1] = (upper[1] ?? 0) + 1
  upper[2] = 0
  return [
    { operator: '>=', version },
    { operator: '<', version: upper },
  ]
}

function padVersion(parts: number[]): number[] {
  const padded = [...parts]
  while (padded.length < 3) padded.push(0)
  return padded
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length, 3)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function hasSatisfyingVersion(predicates: Predicate[]): boolean {
  const exact = predicates.filter((item) => item.operator === '=')
  if (exact.length) {
    const candidate = exact[0]!.version
    return predicates.every((item) => predicateMatches(candidate, item))
  }
  let lower: { version: number[]; inclusive: boolean } | null = null
  let upper: { version: number[]; inclusive: boolean } | null = null
  for (const predicate of predicates) {
    if (predicate.operator === '>' || predicate.operator === '>=') {
      const inclusive = predicate.operator === '>='
      if (
        !lower ||
        compareVersions(predicate.version, lower.version) > 0 ||
        (compareVersions(predicate.version, lower.version) === 0 && !inclusive)
      )
        lower = { version: predicate.version, inclusive }
    }
    if (predicate.operator === '<' || predicate.operator === '<=') {
      const inclusive = predicate.operator === '<='
      if (
        !upper ||
        compareVersions(predicate.version, upper.version) < 0 ||
        (compareVersions(predicate.version, upper.version) === 0 && !inclusive)
      )
        upper = { version: predicate.version, inclusive }
    }
  }
  if (!lower || !upper) return true
  const comparison = compareVersions(lower.version, upper.version)
  return comparison < 0 || (comparison === 0 && lower.inclusive && upper.inclusive)
}

function predicateMatches(version: number[], predicate: Predicate): boolean {
  const comparison = compareVersions(version, predicate.version)
  if (predicate.operator === '<') return comparison < 0
  if (predicate.operator === '<=') return comparison <= 0
  if (predicate.operator === '>') return comparison > 0
  if (predicate.operator === '>=') return comparison >= 0
  return comparison === 0
}

function formatVersion(parts: number[]): string {
  return padVersion(parts).join('.')
}
