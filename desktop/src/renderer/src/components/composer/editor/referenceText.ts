/**
 * Reference chips in plain text (E-track contract §1–2), without the editor:
 * which parts of a message are chips — from saved `references` when they fit
 * the text, else from the names the catalog knows (and the old composer's
 * `@skill(name)` / `@mcp(name)` markers). Shared by the composer document
 * and the user's message bubble. Pure.
 */
import type { MessageReference } from '../../../types'

export type ReferenceKind = MessageReference['kind']

/** Known names: a label for each id that can be a chip. */
export interface ComposerCatalog {
  skill(id: string): string | undefined
  plugin(id: string): string | undefined
}

export const EMPTY_CATALOG: ComposerCatalog = {
  skill: () => undefined,
  plugin: () => undefined,
}

export const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/
const LABEL_MAX = 80

export function gestureOf(kind: ReferenceKind, id: string): string {
  return kind === 'skill' ? `/${id}` : `@${id}`
}

export function validId(kind: ReferenceKind, id: string): boolean {
  return kind === 'skill' ? SKILL_ID.test(id) : PLUGIN_ID.test(id)
}

export function chipLabel(label: string, id: string): string {
  const text = label.trim() || id
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text
}

/** Whether `references` fit `content` (the contract's invariants). */
export function referencesFit(
  content: string,
  references: readonly MessageReference[],
): boolean {
  let last = 0
  for (const reference of references) {
    if (
      !validId(reference.kind, reference.id) ||
      reference.start < last ||
      reference.end > content.length ||
      content.slice(reference.start, reference.end) !==
        gestureOf(reference.kind, reference.id)
    )
      return false
    last = reference.end
  }
  return true
}

/** One piece of a line: a chip, a replacement, or plain text between them. */
export interface ReferenceSpan {
  start: number
  end: number
  chip?: { kind: ReferenceKind; id: string; label: string }
  /** Replacement text (an old MCP marker). */
  text?: string
}

/** `@skill(name)` / `@mcp(name)` from the old composer. */
const LEGACY_TOKEN = /@(skill|mcp)\(([A-Za-z0-9_.-]+)\)/g
/** A complete `/name` or `@id` at the start or after whitespace. */
const GESTURE =
  /(^|\s)([/@])([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)(?=\s|$)/g

/** Chips and replacements the catalog finds in plain text. */
export function spansFromText(
  text: string,
  catalog: ComposerCatalog,
): ReferenceSpan[] {
  const spans: ReferenceSpan[] = []
  for (const match of text.matchAll(LEGACY_TOKEN)) {
    const start = match.index
    const end = start + match[0].length
    const [, kind, name] = match
    if (kind === 'skill') {
      const id = name!.toLowerCase()
      if (SKILL_ID.test(id))
        spans.push({
          start,
          end,
          chip: { kind: 'skill', id, label: catalog.skill(id) ?? id },
        })
    } else spans.push({ start, end, text: `MCP: ${name}` })
  }
  for (const match of text.matchAll(GESTURE)) {
    const start = match.index + match[1]!.length
    const end = start + 1 + match[3]!.length
    if (spans.some((span) => start < span.end && end > span.start)) continue
    const kind: ReferenceKind = match[2] === '/' ? 'skill' : 'plugin'
    const id = match[3]!
    const label = kind === 'skill' ? catalog.skill(id) : catalog.plugin(id)
    if (label === undefined || !validId(kind, id)) continue
    spans.push({ start, end, chip: { kind, id, label } })
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** Spans for saved references (they must fit the text). */
export function spansFromReferences(
  references: readonly MessageReference[],
): ReferenceSpan[] {
  return references.map((reference) => ({
    start: reference.start,
    end: reference.end,
    chip: { kind: reference.kind, id: reference.id, label: reference.label },
  }))
}

export type MessageSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'chip'
      chip: { kind: ReferenceKind; id: string; label: string }
      /** The skill or plugin still exists (else the chip is greyed). */
      available: boolean
    }

/**
 * A sent message as text and chips: its saved references when they fit,
 * else the names the catalog knows now (older messages).
 */
export function messageSegments(
  text: string,
  references: readonly MessageReference[] | undefined,
  catalog: ComposerCatalog,
): MessageSegment[] {
  const spans =
    references?.length && referencesFit(text, references)
      ? spansFromReferences(references)
      : spansFromText(text, catalog)
  const segments: MessageSegment[] = []
  let last = 0
  const pushText = (value: string): void => {
    if (!value) return
    const previous = segments.at(-1)
    if (previous?.kind === 'text') previous.text += value
    else segments.push({ kind: 'text', text: value })
  }
  for (const span of spans) {
    pushText(text.slice(last, span.start))
    if (span.chip) {
      const known =
        span.chip.kind === 'skill'
          ? catalog.skill(span.chip.id)
          : catalog.plugin(span.chip.id)
      segments.push({
        kind: 'chip',
        chip: { ...span.chip, label: chipLabel(span.chip.label, span.chip.id) },
        available: known !== undefined,
      })
    } else pushText(span.text ?? '')
    last = span.end
  }
  pushText(text.slice(last))
  return segments
}
