import { history, undo } from 'prosemirror-history'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import {
  composerDocFromText,
  composerSchema,
  serializeComposer,
  type ComposerCatalog,
} from './composerDocument'
import {
  beginDictation,
  commitDictation,
  dictationDraftKey,
  dictationDraftPlugin,
  endDictation,
  hasDictationDraft,
  showDictationPartial,
  spacedDictation,
} from './dictationDraft'

const catalog: ComposerCatalog = {
  skill: (name) => (name === 'image-gen' ? 'Image Gen' : undefined),
  plugin: () => undefined,
}

/** A composer state with the caret (or selection) at text offsets of the first line. */
function stateOf(text: string, from?: number, to?: number): EditorState {
  const doc = composerDocFromText(text, catalog)
  const state = EditorState.create({
    schema: composerSchema,
    doc,
    plugins: [dictationDraftPlugin, history()],
  })
  const selection =
    from === undefined
      ? TextSelection.atEnd(state.doc)
      : TextSelection.create(state.doc, 1 + from, 1 + (to ?? from))
  return state.apply(state.tr.setSelection(selection))
}

function apply(state: EditorState, tr: Transaction | null): EditorState {
  if (!tr) throw new Error('no transaction')
  return state.apply(tr)
}

function content(state: EditorState): string {
  return serializeComposer(state.doc).content
}

function draft(state: EditorState) {
  return dictationDraftKey.getState(state)?.draft ?? null
}

describe('dictation draft in the composer', () => {
  it('shows partial results as a draft and inserts the final once', () => {
    let state = stateOf('')
    state = apply(state, beginDictation(state, 's1'))
    state = apply(state, showDictationPartial(state, 's1', '你'))
    state = apply(state, showDictationPartial(state, 's1', '你好'))
    expect(content(state)).toBe('')
    expect(draft(state)?.text).toBe('你好')
    state = apply(state, commitDictation(state, 's1', '你好。'))
    expect(content(state)).toBe('你好。')
    expect(draft(state)).toBeNull()
    expect(commitDictation(state, 's1', '你好。')).toBeNull()
  })

  it('inserts in the middle of a draft with the spaces English needs', () => {
    let state = stateOf('hello world', 5)
    state = apply(state, beginDictation(state, 's1'))
    state = apply(state, commitDictation(state, 's1', 'big'))
    expect(content(state)).toBe('hello big world')
  })

  it('replaces the selection it began with', () => {
    let state = stateOf('hello world', 6, 11)
    state = apply(state, beginDictation(state, 's1'))
    expect(draft(state)).toMatchObject({ from: 7, to: 12 })
    state = apply(state, commitDictation(state, 's1', 'there'))
    expect(content(state)).toBe('hello there')
  })

  it('leaves reference chips alone', () => {
    let state = stateOf('/image-gen 画一只猫')
    expect(serializeComposer(state.doc).references).toHaveLength(1)
    state = apply(state, beginDictation(state, 's1'))
    state = apply(state, commitDictation(state, 's1', '要橘色的'))
    expect(serializeComposer(state.doc)).toMatchObject({
      content: '/image-gen 画一只猫要橘色的',
      references: [{ kind: 'skill', id: 'image-gen', start: 0, end: 10 }],
    })
  })

  it('keeps what you type meanwhile, before and at the dictation spot', () => {
    let state = stateOf('hello')
    state = apply(state, beginDictation(state, 's1'))
    state = state.apply(state.tr.insertText(' there', 6))
    state = state.apply(state.tr.insertText('Say: ', 1))
    state = apply(state, commitDictation(state, 's1', 'world'))
    expect(content(state)).toBe('Say: hello world there')
  })

  it('drops the draft on cancel, and ignores a late final', () => {
    let state = stateOf('keep me')
    state = apply(state, beginDictation(state, 's1'))
    state = apply(state, showDictationPartial(state, 's1', 'noise'))
    state = apply(state, endDictation(state, 's1'))
    expect(draft(state)).toBeNull()
    expect(content(state)).toBe('keep me')
    expect(commitDictation(state, 's1', 'late')).toBeNull()
  })

  it('ignores partial results of another dictation', () => {
    let state = stateOf('')
    state = apply(state, beginDictation(state, 's1'))
    state = apply(state, showDictationPartial(state, 's2', 'other'))
    expect(draft(state)?.text).toBe('')
  })

  it('undoes the whole insertion in one step', () => {
    let state = stateOf('hello')
    state = apply(state, beginDictation(state, 's1'))
    state = apply(state, commitDictation(state, 's1', 'there'))
    expect(content(state)).toBe('hello there')
    undo(state, (tr) => {
      state = state.apply(tr)
    })
    expect(content(state)).toBe('hello')
  })

  it('puts the final at the caret when the draft was replaced meanwhile', () => {
    // A restored or cleared draft rebuilds the editor state.
    let state = stateOf('new draft')
    state = apply(state, commitDictation(state, 's1', 'tail'))
    expect(content(state)).toBe('new draft tail')
  })

  it('says when a draft is on screen, so no placeholder goes under it', () => {
    let state = stateOf('')
    expect(hasDictationDraft(state)).toBe(false)
    state = apply(state, beginDictation(state, 's1'))
    expect(hasDictationDraft(state)).toBe(true)
    state = apply(state, showDictationPartial(state, 's1', '你好'))
    expect(hasDictationDraft(state)).toBe(true)
    state = apply(state, endDictation(state, 's1'))
    expect(hasDictationDraft(state)).toBe(false)
  })

  it('ends without inserting when nothing was heard', () => {
    let state = stateOf('hello')
    state = apply(state, beginDictation(state, 's1'))
    state = apply(state, commitDictation(state, 's1', '  '))
    expect(content(state)).toBe('hello')
    expect(draft(state)).toBeNull()
  })
})

describe('dictation spacing', () => {
  it('spaces English words and nothing else', () => {
    expect(spacedDictation('o', 'big', 'w')).toBe(' big ')
    expect(spacedDictation(' ', 'big', ' ')).toBe('big')
    expect(spacedDictation('', 'Hello.', '')).toBe('Hello.')
    expect(spacedDictation('.', 'Next', '')).toBe(' Next')
    expect(spacedDictation('好', '世界', '啊')).toBe('世界')
    expect(spacedDictation('o', '你好', 'w')).toBe('你好')
  })

  it('keeps a space next to a chip', () => {
    expect(spacedDictation('￼', '画一只猫', '')).toBe(' 画一只猫')
    expect(spacedDictation('', 'hi', '￼')).toBe('hi ')
  })
})
