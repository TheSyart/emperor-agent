/**
 * Dictation in the composer editor (VO-03). While you speak, the partial
 * transcript is drawn as an uncommitted draft where dictation began — the
 * caret, or the selection it will replace — and that spot follows whatever
 * you type meanwhile. The final transcript is inserted there once, as its
 * own undo step; a repeated final, or one for a dictation already ended,
 * changes nothing. Reference chips are never touched unless they were in
 * the selection. Nothing here sends a message.
 */
import { closeHistory } from 'prosemirror-history'
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export interface DictationDraft {
  session: string
  /** Where the final goes (from === to: at a caret). */
  from: number
  to: number
  /** The latest partial transcript, shown but not in the document. */
  text: string
}

interface DictationDraftState {
  draft: DictationDraft | null
  /** The last dictation that ended here; its late final is ignored. */
  ended: string | null
}

type DictationMeta =
  | { type: 'begin'; session: string }
  | { type: 'partial'; session: string; text: string }
  | { type: 'end'; session: string }

export const dictationDraftKey = new PluginKey<DictationDraftState>(
  'dictationDraft',
)

/** Stands in for a chip when reading the text around a position. */
const CHIP = '￼'
const WORDY = /[A-Za-z0-9]/
const CLOSING = /[.,!?;:)]/

export const dictationDraftPlugin = new Plugin<DictationDraftState>({
  key: dictationDraftKey,
  state: {
    init: () => ({ draft: null, ended: null }),
    apply(tr, value, _previous, next) {
      let draft = value.draft
      if (draft && tr.docChanged) {
        const caret = draft.from === draft.to
        // A caret stays before text typed at it; a selection keeps only
        // its own content.
        const from = tr.mapping.map(draft.from, caret ? -1 : 1)
        const to = caret ? from : Math.max(from, tr.mapping.map(draft.to, -1))
        draft = { ...draft, from, to }
      }
      const meta = tr.getMeta(dictationDraftKey) as DictationMeta | undefined
      if (meta?.type === 'begin')
        return {
          draft: {
            session: meta.session,
            from: next.selection.from,
            to: next.selection.to,
            text: '',
          },
          ended: value.ended,
        }
      if (meta?.type === 'end')
        return {
          draft: draft?.session === meta.session ? null : draft,
          ended: meta.session,
        }
      if (meta?.type === 'partial' && draft?.session === meta.session)
        return { ...value, draft: { ...draft, text: meta.text } }
      return draft === value.draft ? value : { ...value, draft }
    },
  },
  props: {
    decorations(state) {
      const draft = dictationDraftKey.getState(state)?.draft
      if (!draft) return null
      const decorations: Decoration[] = []
      if (draft.from < draft.to)
        decorations.push(
          Decoration.inline(draft.from, draft.to, {
            class: 'composer-dictation-replaced',
          }),
        )
      decorations.push(
        Decoration.widget(
          draft.to,
          () => {
            const span = document.createElement('span')
            span.className = 'composer-dictation-draft'
            span.dataset.dictationDraft = ''
            span.textContent = draft.text
            return span
          },
          {
            side: -1,
            key: `dictation:${draft.session}:${draft.text}`,
            ignoreSelection: true,
          },
        ),
      )
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

export function beginDictation(
  state: EditorState,
  session: string,
): Transaction {
  return state.tr.setMeta(dictationDraftKey, { type: 'begin', session })
}

export function showDictationPartial(
  state: EditorState,
  session: string,
  text: string,
): Transaction {
  return state.tr.setMeta(dictationDraftKey, {
    type: 'partial',
    session,
    text,
  })
}

/** Drops the draft (cancelled, failed, or ended without a result). */
export function endDictation(state: EditorState, session: string): Transaction {
  return state.tr.setMeta(dictationDraftKey, { type: 'end', session })
}

/**
 * `text` with the spaces its neighbours need: English words get one on the
 * side that touches another word (or a chip); Chinese and punctuation do not.
 */
export function spacedDictation(
  before: string,
  text: string,
  after: string,
): string {
  const first = text[0] ?? ''
  const last = text.at(-1) ?? ''
  const spaceBefore =
    before === CHIP ||
    ((WORDY.test(before) || CLOSING.test(before)) && WORDY.test(first))
  const spaceAfter =
    after === CHIP ||
    (WORDY.test(after) && (WORDY.test(last) || CLOSING.test(last)))
  return `${spaceBefore ? ' ' : ''}${text}${spaceAfter ? ' ' : ''}`
}

function charBefore(state: EditorState, position: number): string {
  const $at = state.doc.resolve(position)
  return $at.parent.textBetween(
    Math.max(0, $at.parentOffset - 1),
    $at.parentOffset,
    undefined,
    CHIP,
  )
}

function charAfter(state: EditorState, position: number): string {
  const $at = state.doc.resolve(position)
  return $at.parent.textBetween(
    $at.parentOffset,
    Math.min($at.parent.content.size, $at.parentOffset + 1),
    undefined,
    CHIP,
  )
}

/**
 * The final transcript in place of the draft, or at the caret when the
 * editor was rebuilt since (a restored or cleared draft). null: this
 * dictation already ended here. The caller closes history after it, so the
 * insertion is one undo step.
 */
export function commitDictation(
  state: EditorState,
  session: string,
  text: string,
): Transaction | null {
  const plugin = dictationDraftKey.getState(state)
  if (!plugin || plugin.ended === session) return null
  const draft = plugin.draft?.session === session ? plugin.draft : null
  const from = draft ? draft.from : state.selection.from
  const to = draft ? draft.to : state.selection.to
  const tr = closeHistory(state.tr).setMeta(dictationDraftKey, {
    type: 'end',
    session,
  })
  const clean = text.replace(/\s*\n+\s*/g, ' ').trim()
  if (!clean) return tr
  const insert = spacedDictation(
    charBefore(state, from),
    clean,
    charAfter(state, to),
  )
  // The caret follows the text only when it was still at the draft.
  const { selection } = state
  const caretThere =
    (selection.empty && selection.from === to) ||
    (selection.from === from && selection.to === to)
  tr.insertText(insert, from, to)
  if (!caretThere) return tr
  // Only then does the view follow; someone editing elsewhere stays put.
  tr.setSelection(TextSelection.create(tr.doc, from + insert.length))
  return tr.scrollIntoView()
}
