/**
 * The composer's rich document (RF-02, contract
 * private-docs/specs/2026-09-30-references/00-契约.md §1–2): paragraphs of
 * text and atomic reference chips. Pure: the schema, serialization to what
 * the model receives plus `references`, rebuilding a document from text
 * (known names become chips, legacy `@skill(name)` markers too), and the
 * `/` / `@` trigger at the caret.
 */
import { Schema, type Node as PMNode } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'
import type { MessageReference } from '../../../types'
import {
  EMPTY_CATALOG,
  chipLabel,
  gestureOf,
  referencesFit,
  spansFromReferences,
  spansFromText,
  validId,
  type ComposerCatalog,
  type ReferenceSpan,
} from './referenceText'

export {
  EMPTY_CATALOG,
  gestureOf,
  referencesFit,
  validId,
  type ComposerCatalog,
} from './referenceText'

export type ComposerReferenceKind = MessageReference['kind']

/** A chip in the sent text: `content.slice(start, end)` is `/id` or `@id`. */
export type ComposerReference = MessageReference

export interface ComposerOutput {
  /** What the model receives: `/skill`, `@plugin`, paragraphs joined by \n. */
  content: string
  references: ComposerReference[]
}

/** Stands in for a chip when reading the text around the caret. */
const CHIP_CHAR = '￼'

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    chip: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: false,
      attrs: { kind: {}, id: {}, label: {} },
      toDOM: (node) => [
        'span',
        {
          class: 'composer-chip',
          'data-kind': node.attrs.kind,
          'data-id': node.attrs.id,
          role: 'img',
          'aria-label': `${node.attrs.kind === 'skill' ? '技能' : '插件'} ${node.attrs.label}`,
          contenteditable: 'false',
        },
        node.attrs.label,
      ],
      parseDOM: [
        {
          tag: 'span.composer-chip',
          getAttrs: (dom) => {
            const element = dom as HTMLElement
            const kind = element.getAttribute('data-kind')
            const id = element.getAttribute('data-id') ?? ''
            if ((kind !== 'skill' && kind !== 'plugin') || !validId(kind, id))
              return false
            return {
              kind,
              id,
              label: chipLabel(element.textContent ?? id, id),
            }
          },
        },
      ],
    },
  },
})

export function chipNode(
  kind: ComposerReferenceKind,
  id: string,
  label: string,
): PMNode {
  return composerSchema.nodes.chip!.create({
    kind,
    id,
    label: chipLabel(label, id),
  })
}

/** The text for the model and where each chip sits in it. */
export function serializeComposer(doc: PMNode): ComposerOutput {
  let content = ''
  const references: ComposerReference[] = []
  doc.forEach((paragraph, _offset, index) => {
    if (index > 0) content += '\n'
    paragraph.forEach((node) => {
      if (node.type.name === 'chip') {
        const kind = node.attrs.kind as ComposerReferenceKind
        const id = node.attrs.id as string
        const text = gestureOf(kind, id)
        references.push({
          kind,
          id,
          label: node.attrs.label as string,
          start: content.length,
          end: content.length + text.length,
        })
        content += text
      } else content += node.text ?? ''
    })
  })
  return { content, references }
}

function paragraphFrom(
  line: string,
  spans: readonly ReferenceSpan[],
  offset: number,
): PMNode {
  const nodes: PMNode[] = []
  let last = 0
  const pushText = (text: string): void => {
    if (text) nodes.push(composerSchema.text(text))
  }
  for (const span of spans) {
    const start = span.start - offset
    const end = span.end - offset
    pushText(line.slice(last, start))
    if (span.chip)
      nodes.push(chipNode(span.chip.kind, span.chip.id, span.chip.label))
    else pushText(span.text ?? '')
    last = end
  }
  pushText(line.slice(last))
  return composerSchema.nodes.paragraph!.create(null, nodes)
}

/**
 * A document from text. With `references` that fit the text, chips sit
 * exactly there (labels from the references); otherwise known `/name` and
 * `@id` tokens and legacy markers become chips.
 */
export function composerDocFromText(
  text: string,
  catalog: ComposerCatalog = EMPTY_CATALOG,
  references?: readonly ComposerReference[],
): PMNode {
  const lines = text.split('\n')
  const exact =
    references !== undefined &&
    references.length > 0 &&
    referencesFit(text, references)
  const paragraphs: PMNode[] = []
  let offset = 0
  for (const line of lines) {
    const lineEnd = offset + line.length
    const spans: ReferenceSpan[] = exact
      ? spansFromReferences(
          references!.filter(
            (reference) =>
              reference.start >= offset && reference.end <= lineEnd,
          ),
        ).map((span) => ({
          ...span,
          start: span.start - offset,
          end: span.end - offset,
        }))
      : spansFromText(line, catalog)
    paragraphs.push(paragraphFrom(line, spans, 0))
    offset = lineEnd + 1
  }
  return composerSchema.nodes.doc!.create(null, paragraphs)
}

/** Plain text with known tokens turned into chips (for paste). */
export function composerInlineFromText(
  text: string,
  catalog: ComposerCatalog,
): PMNode[][] {
  return text.split('\n').map((line) => {
    const paragraph = paragraphFrom(line, spansFromText(line, catalog), 0)
    const inline: PMNode[] = []
    paragraph.forEach((node) => inline.push(node))
    return inline
  })
}

/** A `/` or `@` being typed at the caret (start of message or after whitespace). */
export interface ComposerTrigger {
  sigil: '/' | '@'
  query: string
  /** Document positions of the typed `/query`. */
  from: number
  to: number
  /** At the very start of the message (the command palette's place). */
  atStart: boolean
}

/**
 * `/query` (no further `/`) or `@query` (a plugin id may carry one
 * `/namespace`), at the start or after whitespace.
 */
const TRIGGER = /(^|\s)(?:(\/)([^\s/@￼]*)|(@)([^\s/@￼]*(?:\/[^\s/@￼]*)?))$/

export function triggerAt(state: EditorState): ComposerTrigger | null {
  const { selection } = state
  if (!selection.empty) return null
  const $from = selection.$from
  if ($from.parent.type.name !== 'paragraph') return null
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    CHIP_CHAR,
  )
  const match = TRIGGER.exec(before)
  if (!match) return null
  const query = match[3] ?? match[5]!
  const to = selection.from
  const from = to - query.length - 1
  const atStart =
    $from.index(0) === 0 && $from.parentOffset === query.length + 1
  return {
    sigil: (match[2] ?? match[4]) as '/' | '@',
    query,
    from,
    to,
    atStart,
  }
}

/**
 * The complete `/name` or `@id` just before the caret, when it names a
 * known skill or plugin: typing a space after it makes it a chip.
 */
export function typedGestureAt(
  state: EditorState,
  catalog: ComposerCatalog,
): {
  from: number
  to: number
  kind: ComposerReferenceKind
  id: string
  label: string
} | null {
  const { selection } = state
  if (!selection.empty) return null
  const $from = selection.$from
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    CHIP_CHAR,
  )
  const match =
    /(^|\s)([/@])([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)$/.exec(
      before,
    )
  if (!match) return null
  const kind: ComposerReferenceKind = match[2] === '/' ? 'skill' : 'plugin'
  const id = match[3]!
  const label = kind === 'skill' ? catalog.skill(id) : catalog.plugin(id)
  if (label === undefined || !validId(kind, id)) return null
  return {
    from: selection.from - id.length - 1,
    to: selection.from,
    kind,
    id,
    label,
  }
}
