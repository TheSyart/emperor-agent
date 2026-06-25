import type { RequestedSkill } from '../types'

export type ComposerTokenKind = 'skill' | 'mcp'

export interface ComposerCapabilityToken {
  kind: ComposerTokenKind
  name: string
  raw: string
  start: number
  end: number
}

export type ComposerInlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'token'; tokenKind: ComposerTokenKind; name: string; raw: string }

export interface ParsedComposerCapabilityTokens {
  tokens: ComposerCapabilityToken[]
  skills: string[]
  mcps: string[]
}

export interface NormalizedComposerCapabilityInput {
  content: string
  displayContent: string
  requestedSkills: RequestedSkill[]
}

const TOKEN_PATTERN = /@(skill|mcp)\(([A-Za-z0-9_.-]+)\)/g

export function parseComposerCapabilityTokens(text: string): ParsedComposerCapabilityTokens {
  const tokens: ComposerCapabilityToken[] = []
  const skills: string[] = []
  const mcps: string[] = []
  const seenSkills = new Set<string>()
  const seenMcps = new Set<string>()

  TOKEN_PATTERN.lastIndex = 0
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const kind = match[1] as ComposerTokenKind
    const name = match[2]
    const start = match.index ?? 0
    const token = {
      kind,
      name,
      raw: match[0],
      start,
      end: start + match[0].length,
    }
    tokens.push(token)
    if (kind === 'skill' && !seenSkills.has(name)) {
      seenSkills.add(name)
      skills.push(name)
    }
    if (kind === 'mcp' && !seenMcps.has(name)) {
      seenMcps.add(name)
      mcps.push(name)
    }
  }

  return { tokens, skills, mcps }
}

export function normalizeComposerCapabilityInput(text: string): NormalizedComposerCapabilityInput {
  const parsed = parseComposerCapabilityTokens(text)
  return {
    content: replaceCapabilityTokensForModel(text),
    displayContent: text,
    requestedSkills: parsed.skills.map((name) => ({ name, source: 'slash' as const })),
  }
}

export function renderComposerInlineTokens(text: string): ComposerInlineSegment[] {
  const parsed = parseComposerCapabilityTokens(text)
  if (!parsed.tokens.length) return [{ kind: 'text', text }]

  const segments: ComposerInlineSegment[] = []
  let cursor = 0
  for (const token of parsed.tokens) {
    if (token.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, token.start) })
    }
    segments.push({
      kind: 'token',
      tokenKind: token.kind,
      name: token.name,
      raw: token.raw,
    })
    cursor = token.end
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }
  return segments
}

export function hasComposerCapabilityTokens(text: string): boolean {
  TOKEN_PATTERN.lastIndex = 0
  return TOKEN_PATTERN.test(text)
}

function replaceCapabilityTokensForModel(text: string): string {
  TOKEN_PATTERN.lastIndex = 0
  return text.replace(TOKEN_PATTERN, (_raw, kind: ComposerTokenKind, name: string) => {
    return kind === 'skill' ? `Skill: ${name}` : `MCP: ${name}`
  })
}
