/**
 * Mounted composer editors by their editable element, so tests can drive an
 * editor the way ProseMirror handles input (see editorTesting.ts). Weak:
 * an unmounted editor goes with its element.
 */
import type { EditorView } from 'prosemirror-view'

const views = new WeakMap<Element, EditorView>()

export function trackEditorView(view: EditorView): void {
  views.set(view.dom, view)
}

export function editorViewOf(element: Element | null): EditorView | undefined {
  return element === null ? undefined : views.get(element)
}
