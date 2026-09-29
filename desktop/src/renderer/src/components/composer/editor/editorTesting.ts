/**
 * Test helpers for the composer editor (jsdom has no real text input):
 * typing goes through the editor's text-input handler first, exactly as
 * ProseMirror does for the DOM, then inserts; keys are real keydown events
 * on the editable element.
 */
import type { EditorView } from 'prosemirror-view'
import { editorViewOf } from './editorViews'

export function composerView(root: ParentNode): EditorView {
  const view = editorViewOf(root.querySelector('.composer-editor-input'))
  if (!view) throw new Error('no composer editor mounted')
  return view
}

export function typeInto(view: EditorView, text: string): void {
  for (const char of text) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (handle) =>
      handle(view, from, to, char, () =>
        view.state.tr.insertText(char, from, to),
      ),
    )
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to))
  }
}

export function pressKey(
  view: EditorView,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  view.dom.dispatchEvent(event)
  return event
}

/** The editor's text as the user reads it (chips by their labels). */
export function visibleText(view: EditorView): string {
  return view.dom.textContent ?? ''
}
