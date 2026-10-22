import { expect, it } from 'vitest'
import { DecorationSet } from 'prosemirror-view'
import { EditorState } from 'prosemirror-state'
import { composerDocFromText, serializeComposer } from './composerDocument'
import { resourceDecorationPlugin } from './resourceDecorations'

it('decorates URLs without changing text, chip positions or serialization', () => {
  const text = '看看😀 https://github.com/a/b 以及 `https://skip.test`'
  const state = EditorState.create({
    doc: composerDocFromText(text),
    plugins: [resourceDecorationPlugin],
  })
  const decorations = (
    resourceDecorationPlugin.props.decorations!.call(
      resourceDecorationPlugin,
      state,
    ) as DecorationSet
  ).find()
  expect(decorations).toHaveLength(1)
  expect(state.doc.textBetween(decorations[0]!.from, decorations[0]!.to)).toBe(
    'https://github.com/a/b',
  )
  expect(serializeComposer(state.doc)).toEqual({
    content: text,
    references: [],
  })
})

it('excludes closed and unfinished fences across editor paragraphs', () => {
  for (const text of [
    'https://visible.test\n```txt\nhttps://hidden.test\n```',
    'https://visible.test\n~~~\nhttps://hidden.test',
    'https://visible.test\n\n    https://hidden.test',
  ]) {
    const state = EditorState.create({
      doc: composerDocFromText(text),
      plugins: [resourceDecorationPlugin],
    })
    const decorations = (
      resourceDecorationPlugin.props.decorations!.call(
        resourceDecorationPlugin,
        state,
      ) as DecorationSet
    ).find()
    expect(decorations.map((d) => state.doc.textBetween(d.from, d.to))).toEqual(
      ['https://visible.test'],
    )
    expect(serializeComposer(state.doc).content).toBe(text)
  }
})

it('maps decorations after reference chips and suppresses them during IME composition', () => {
  const text = '/test\n😀 https://visible.test'
  let state = EditorState.create({
    doc: composerDocFromText(text, {
      skill: (id) => (id === 'test' ? '测试' : undefined),
      plugin: () => undefined,
    }),
    plugins: [resourceDecorationPlugin],
  })
  const read = () =>
    (
      resourceDecorationPlugin.props.decorations!.call(
        resourceDecorationPlugin,
        state,
      ) as DecorationSet
    ).find()
  expect(state.doc.textBetween(read()[0]!.from, read()[0]!.to)).toBe(
    'https://visible.test',
  )
  const view = {
    state,
    dispatch: (tr: Parameters<typeof state.apply>[0]) => {
      state = state.apply(tr)
    },
  }
  resourceDecorationPlugin.props.handleDOMEvents!.compositionstart!.call(
    resourceDecorationPlugin,
    view as never,
    { type: 'compositionstart' } as CompositionEvent,
  )
  expect(read()).toHaveLength(0)
  resourceDecorationPlugin.props.handleDOMEvents!.compositionend!.call(
    resourceDecorationPlugin,
    view as never,
    { type: 'compositionend' } as CompositionEvent,
  )
  expect(read()).toHaveLength(1)
  expect(serializeComposer(state.doc).content).toBe(text)
})

it('maps marks while typing and re-detects links only after the pause', () => {
  const marks = (state: EditorState) =>
    (
      resourceDecorationPlugin.props.decorations!.call(
        resourceDecorationPlugin,
        state,
      ) as DecorationSet
    )
      .find()
      .map((d) => state.doc.textBetween(d.from, d.to))
  let state = EditorState.create({
    doc: composerDocFromText('看 https://a.test'),
    plugins: [resourceDecorationPlugin],
  })
  expect(marks(state)).toEqual(['https://a.test'])
  state = state.apply(
    state.tr.insertText(' 和 https://b.test', state.doc.content.size - 1),
  )
  // Typing: the old mark moves with the text, nothing is re-parsed yet.
  expect(marks(state)).toEqual(['https://a.test'])
  state = state.apply(state.tr.setMeta('resource-redecorate', true))
  expect(marks(state)).toEqual(['https://a.test', 'https://b.test'])
})
