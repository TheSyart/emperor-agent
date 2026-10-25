import { createHash } from 'node:crypto'
import codex01534 from './protocol/codex-0.153.4/digest.json'
import codex01630 from './protocol/codex-0.163.0/digest.json'
import codex01534Features from './protocol/codex-0.153.4/features.json'
import codex01630Features from './protocol/codex-0.163.0/features.json'

/**
 * Compatibility is a capability handshake (AGT-01), not an exact version
 * pinned in the user's configuration:
 * - Claude Code: Emperor runs the user's installed, unmodified claude
 *   (AGT-12: it ships none). It needs `claude auth status` (2.1.41) and
 *   `claude auth login --console` (2.1.79), so at least 2.1.79; the SDK
 *   `init` message is checked again at run time.
 * - Codex: the installed CLI must share a major.minor with a protocol Emperor
 *   has verified (0.153 since AGT-01, 0.163 since AGT-13). Within that minor,
 *   a digest of the CLI's generated JSON schema tells "verified" from "may be
 *   incompatible".
 */

/** The Agent SDK Emperor drives the installed claude with. */
export const CLAUDE_SDK_VERSION = '0.3.281'

export interface SemanticVersion {
  major: number
  minor: number
  patch: number
}

export function parseVersion(text: unknown): SemanticVersion | undefined {
  if (typeof text !== 'string') return undefined
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text)
  if (!match) return undefined
  return { major: +match[1]!, minor: +match[2]!, patch: +match[3]! }
}

export function formatVersion(version: SemanticVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

function compare(a: SemanticVersion, b: SemanticVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** The first claude with `auth status` (2.1.41) and `auth login --console`. */
export const CLAUDE_MINIMUM_VERSION: SemanticVersion = {
  major: 2,
  minor: 1,
  patch: 79,
}
export const CLAUDE_REQUIRED_RANGE = `>= ${formatVersion(CLAUDE_MINIMUM_VERSION)}`

export function claudeVersionSupported(version: SemanticVersion): boolean {
  return compare(version, CLAUDE_MINIMUM_VERSION) >= 0
}

/** A Claude Code release Emperor checked offline (VER-04). */
export interface VerifiedClaudeVersion {
  /** The exact release. */
  version: string
  /** YYYY-MM-DD */
  verifiedAt: string
  /** The builtin plugins it ships (VER-01's fixtures), all turned off. */
  builtinPlugins: string[]
}

/**
 * The Claude Code releases 升级 may install (VER-04), oldest first: each one
 * passed `scripts/claude-init-handshake.mjs` and the offline self-check
 * (VER-01, 2026-10-24: npm's latest was 2.1.310, stable 2.1.308). A newer
 * release is 「尚未验证」 until it is listed here; the process is in
 * docs/development/external-agent-adapters.md.
 */
export const KNOWN_CLAUDE_VERSIONS: readonly VerifiedClaudeVersion[] = [
  { version: '2.1.281', verifiedAt: '2026-10-22', builtinPlugins: [] },
  {
    version: '2.1.308',
    verifiedAt: '2026-10-24',
    builtinPlugins: ['cc-plugin-plugin-authoring@builtin'],
  },
  {
    version: '2.1.310',
    verifiedAt: '2026-10-24',
    builtinPlugins: ['cc-plugin-plugin-authoring@builtin'],
  },
]

/**
 * Capability fields of the SDK `system/init` message. Returns a reason when
 * the running claude cannot honour what Emperor relies on.
 */
export function claudeInitIssue(
  message: Record<string, unknown>,
  options: { requireVersion: boolean },
): string | undefined {
  const reported = message.claude_code_version
  if (reported === undefined) {
    if (options.requireVersion)
      return (
        'Claude did not report its version; it needs ' + CLAUDE_REQUIRED_RANGE
      )
  } else {
    const version = parseVersion(reported)
    if (!version || !claudeVersionSupported(version))
      return `Claude ${String(reported).slice(0, 32)} is older than the supported ${CLAUDE_REQUIRED_RANGE}`
  }
  if (
    message.permissionMode !== undefined &&
    message.permissionMode !== 'default'
  )
    return 'Claude ignored the requested permission mode'
  if (
    message.tools !== undefined &&
    (!Array.isArray(message.tools) ||
      message.tools.some((tool) => typeof tool !== 'string'))
  )
    return 'Claude reported an unreadable tool list'
  return undefined
}

export interface CodexProtocol {
  /** The Codex release whose schema produced the digests. */
  version: string
  /** Schema files Emperor's adapter depends on, relative to the bundle. */
  files: string[]
  /** Accepted digests of those files (see codexProtocolDigest). */
  digests: string[]
}

function protocol(value: {
  codexVersion: string
  files: string[]
  digests: string[]
}): CodexProtocol {
  return {
    version: value.codexVersion,
    files: value.files,
    digests: value.digests,
  }
}

/**
 * One entry per `protocol/codex-<version>/digest.json`, oldest first;
 * register new ones here. 0.163 differs from 0.153 only by additions to what
 * the adapter uses (AGT-13; docs/architecture/external-agent-delegation.md).
 */
export const KNOWN_CODEX_PROTOCOLS: readonly CodexProtocol[] = [
  protocol(codex01534),
  protocol(codex01630),
]

/**
 * Each verified protocol's feature defaults (`features.json`, `codex
 * features list` with no overrides): name → on. The self-check (VER-04)
 * compares a live Codex against them; codex-contract.test.ts pins what
 * stays on under Emperor's overrides.
 */
export const CODEX_FEATURE_DEFAULTS: Readonly<
  Record<string, Readonly<Record<string, boolean>>>
> = Object.fromEntries(
  [codex01534Features, codex01630Features].map((recorded) => [
    recorded.codexVersion,
    Object.fromEntries(
      Object.entries(
        recorded.features as Record<string, { enabled: boolean }>,
      ).map(([name, f]) => [name, f.enabled]),
    ),
  ]),
)

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}

/**
 * Digest of the schema files Emperor depends on. Key order and whitespace do
 * not count, so the checked-in (formatted) schema and the CLI's raw output
 * agree. A missing or unreadable file yields undefined.
 */
export function codexProtocolDigest(
  read: (file: string) => string | undefined,
  files: readonly string[],
): string | undefined {
  const hash = createHash('sha256').update('emperor-codex-protocol/1\n')
  for (const file of [...files].sort()) {
    const text = read(file)
    if (text === undefined) return undefined
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return undefined
    }
    hash.update(file + '\n' + canonicalJson(value) + '\n')
  }
  return hash.digest('hex')
}

/** Human-readable supported range, e.g. "0.153.x". */
export function codexRequiredRange(
  protocols: readonly CodexProtocol[] = KNOWN_CODEX_PROTOCOLS,
): string {
  return [
    ...new Set(
      protocols.flatMap((p) => {
        const v = parseVersion(p.version)
        return v ? [`${v.major}.${v.minor}.x`] : []
      }),
    ),
  ].join(' / ')
}

/** Known protocols that share the CLI's major.minor, newest first. */
export function codexProtocolsFor(
  version: SemanticVersion,
  protocols: readonly CodexProtocol[] = KNOWN_CODEX_PROTOCOLS,
): CodexProtocol[] {
  return protocols
    .filter((p) => {
      const known = parseVersion(p.version)
      return (
        !!known &&
        known.major === version.major &&
        known.minor === version.minor
      )
    })
    .sort((a, b) => compare(parseVersion(b.version)!, parseVersion(a.version)!))
}

/** Checks the version Codex reports in its `initialize` user agent. */
export function codexUserAgentIssue(
  userAgent: unknown,
  protocols: readonly CodexProtocol[] = KNOWN_CODEX_PROTOCOLS,
): string | undefined {
  const version = parseVersion(userAgent)
  if (!version) return 'Codex initialize did not report a version'
  if (!codexProtocolsFor(version, protocols).length)
    return `Codex ${formatVersion(version)} is outside the supported ${codexRequiredRange(protocols)}`
  return undefined
}
