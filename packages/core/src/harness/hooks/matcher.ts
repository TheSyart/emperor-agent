/**
 * Matcher shared by both hook dialects (ported from dsh-hook-protocol).
 * Claude treats alphanumeric/underscore/pipe patterns as literal
 * alternatives and other patterns as regex; Codex treats every non-empty
 * pattern as an unanchored regex. Missing, empty, and `*` match all.
 */

import type { MatcherMode } from './types'

function isMatchAll(
  matcher: string | undefined,
): matcher is undefined | '' | '*' {
  return matcher === undefined || matcher === '' || matcher === '*'
}

const CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/

function compileRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

/** `undefined` for a valid matcher, otherwise a stable diagnostic (used at config parse time). */
export function matcherDiagnostic(
  matcher: string | undefined,
  mode: MatcherMode,
): string | undefined {
  if (isMatchAll(matcher)) return undefined
  if (mode === 'claude-code' && CLAUDE_LITERAL.test(matcher)) return undefined
  return compileRegex(matcher) === undefined
    ? `invalid ${mode} regex matcher ${JSON.stringify(matcher)}`
    : undefined
}

/** Whether `matcher` selects `query`; an invalid regex is a non-match (never throws). */
export function matchesMatcher(
  matcher: string | undefined,
  query: string,
  mode: MatcherMode,
): boolean {
  if (isMatchAll(matcher)) return true
  if (mode === 'claude-code' && CLAUDE_LITERAL.test(matcher)) {
    return matcher.split('|').includes(query)
  }
  return compileRegex(matcher)?.test(query) ?? false
}
