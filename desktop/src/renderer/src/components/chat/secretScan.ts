import type { MessageReference } from '../../types'

/**
 * Pre-send check for credentials pasted into a message (DSH-24): provider
 * API keys, access tokens and PEM private keys. A match only asks the user;
 * nothing is changed unless they choose 「遮掩后发送」.
 */
export const SECRET_MASK = '[已遮掩]'

export type SecretKind = 'api-key' | 'token' | 'private-key'

export interface SecretMatch {
  start: number
  end: number
  kind: SecretKind
}

const PATTERNS: ReadonlyArray<{ kind: SecretKind; pattern: RegExp }> = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  // OpenAI / Anthropic / DeepSeek and most OpenAI-compatible providers.
  { kind: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: 'token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: 'token', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: 'token',
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
]

/** Non-overlapping matches in text order. */
export function findSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = []
  for (const { kind, pattern } of PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern))
      found.push({
        start: match.index,
        end: match.index + match[0].length,
        kind,
      })
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: SecretMatch[] = []
  for (const match of found)
    if (kept.length === 0 || match.start >= kept[kept.length - 1]!.end)
      kept.push(match)
  return kept
}

/**
 * Replace every match with SECRET_MASK. Chips after a replaced span move
 * with the text; a chip that overlaps one is dropped.
 */
export function maskSecrets(
  content: string,
  references: readonly MessageReference[],
): { content: string; references: MessageReference[] } {
  const matches = findSecrets(content)
  if (matches.length === 0)
    return { content, references: references.map((ref) => ({ ...ref })) }
  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += content.slice(cursor, match.start) + SECRET_MASK
    cursor = match.end
  }
  out += content.slice(cursor)
  const shift = (offset: number): number =>
    matches.reduce(
      (total, match) =>
        match.end <= offset
          ? total + SECRET_MASK.length - (match.end - match.start)
          : total,
      offset,
    )
  const kept = references
    .filter(
      (ref) =>
        !matches.some(
          (match) => ref.start < match.end && match.start < ref.end,
        ),
    )
    .map((ref) => ({ ...ref, start: shift(ref.start), end: shift(ref.end) }))
  return { content: out, references: kept }
}
