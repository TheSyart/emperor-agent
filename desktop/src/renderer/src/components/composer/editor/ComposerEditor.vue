<script setup lang="ts">
/**
 * ComposerEditor — the message input as a ProseMirror editor (RF-02): text
 * plus atomic reference chips (技能 / 插件) that the caret skips and
 * Backspace removes whole. The document and its rules live in
 * composerDocument.ts; the composer controller owns behaviour (palettes,
 * sending) and reaches the editor through the exposed methods.
 *
 * Props:
 * - placeholder, ariaLabel, disabled (read-only while set), hero (taller).
 * - catalog: known skill / plugin names (typing `/name ` or pasting such
 *   text turns them into chips; unknown names stay text).
 * - keydown?: runs before the editor's own keys; calling preventDefault()
 *   on the event stops the editor (Enter to send, palette keys).
 * Emits:
 * - change({ content, references }) on every edit;
 * - trigger(trigger | null): a `/` or `@` being typed at the caret;
 * - focus.
 * Exposes: focus(), setContent(text, references?), insertChip(kind, id,
 * label), replaceWithChip(from, to, kind, id, label), chipifyTyped(),
 * output(), and for dictation (dictationDraft.ts) dictationBegin(session),
 * dictationPartial(session, text), dictationFinal(session, text) and
 * dictationEnd(session).
 *
 * Enter is left to the controller; Shift+Enter starts a new line; Enter
 * while an input method composes is never a send (the browser's
 * composition owns it). Each chip insertion is its own undo step.
 */
import { baseKeymap, splitBlock } from 'prosemirror-commands'
import { closeHistory, history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import {
  DOMSerializer,
  Fragment,
  Slice,
  type Node as PMNode,
} from 'prosemirror-model'
import {
  EditorState,
  Plugin,
  TextSelection,
  type Transaction,
} from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  chipNode,
  composerDocFromText,
  composerInlineFromText,
  composerSchema,
  gestureOf,
  serializeComposer,
  triggerAt,
  typedGestureAt,
  type ComposerCatalog,
  type ComposerOutput,
  type ComposerReference,
  type ComposerReferenceKind,
  type ComposerTrigger,
} from './composerDocument'
import {
  beginDictation,
  commitDictation,
  dictationDraftPlugin,
  endDictation,
  hasDictationDraft,
  showDictationPartial,
} from './dictationDraft'
import { trackEditorView } from './editorViews'
import { resourceDecorationPlugin } from './resourceDecorations'

const props = withDefaults(
  defineProps<{
    placeholder?: string
    ariaLabel?: string
    disabled?: boolean
    hero?: boolean
    catalog: ComposerCatalog
    keydown?: (event: KeyboardEvent) => void
  }>(),
  {
    placeholder: '',
    ariaLabel: '消息输入框',
    disabled: false,
    hero: false,
    keydown: undefined,
  },
)

const emit = defineEmits<{
  change: [output: ComposerOutput]
  trigger: [trigger: ComposerTrigger | null]
  focus: []
}>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

function isEmpty(state: EditorState): boolean {
  const doc = state.doc
  return doc.childCount === 1 && doc.firstChild!.content.size === 0
}

function attributes(): Record<string, string> {
  return {
    class: 'composer-editor-input',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': props.ariaLabel,
    'aria-disabled': props.disabled ? 'true' : 'false',
  }
}

/**
 * The placeholder sits on the empty first line, unless a dictation draft
 * shows there: the draft is a decoration, so the document is still empty.
 */
const placeholderPlugin = new Plugin({
  props: {
    decorations: (state) =>
      isEmpty(state) && props.placeholder && !hasDictationDraft(state)
        ? DecorationSet.create(state.doc, [
            Decoration.node(0, state.doc.firstChild!.nodeSize, {
              class: 'composer-editor-empty',
              'data-placeholder': props.placeholder,
            }),
          ])
        : null,
  },
})

/**
 * A chip (and a following space) in place of `from`–`to`, as its own undo
 * step: the history closes before it and again after it.
 */
function commitChip(
  target: EditorView,
  from: number,
  to: number,
  kind: ComposerReferenceKind,
  id: string,
  label: string,
): void {
  target.dispatch(chipTransaction(target.state, from, to, kind, id, label))
  target.dispatch(closeHistory(target.state.tr))
}

function chipTransaction(
  state: EditorState,
  from: number,
  to: number,
  kind: ComposerReferenceKind,
  id: string,
  label: string,
): Transaction {
  const tr = closeHistory(state.tr)
  const chip = chipNode(kind, id, label)
  const $to = state.doc.resolve(to)
  const next = $to.parent.textBetween(
    $to.parentOffset,
    Math.min($to.parent.content.size, $to.parentOffset + 1),
    undefined,
    '￼',
  )
  const nodes: PMNode[] = [chip]
  if (next === '' || !/\s/.test(next)) nodes.push(composerSchema.text(' '))
  tr.replaceWith(from, to, nodes)
  const end = from + nodes.reduce((size, node) => size + node.nodeSize, 0)
  tr.setSelection(TextSelection.create(tr.doc, end))
  return tr.scrollIntoView()
}

function report(state: EditorState, docChanged: boolean): void {
  if (docChanged) emit('change', serializeComposer(state.doc))
  emit('trigger', triggerAt(state))
}

function dispatch(tr: Transaction): void {
  if (!view) return
  const next = view.state.apply(tr)
  view.updateState(next)
  report(next, tr.docChanged)
}

function pasteText(text: string): boolean {
  if (!view) return false
  const lines = composerInlineFromText(text, props.catalog)
  const slice =
    lines.length === 1
      ? new Slice(Fragment.from(lines[0]!), 0, 0)
      : new Slice(
          Fragment.from(
            lines.map((inline) =>
              composerSchema.nodes.paragraph!.create(null, inline),
            ),
          ),
          1,
          1,
        )
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
  return true
}

function createState(doc?: PMNode): EditorState {
  return EditorState.create({
    schema: composerSchema,
    ...(doc ? { doc } : {}),
    plugins: [
      placeholderPlugin,
      dictationDraftPlugin,
      resourceDecorationPlugin,
      history(),
      keymap({
        'Mod-z': undo,
        'Shift-Mod-z': redo,
        'Mod-y': redo,
        'Shift-Enter': splitBlock,
      }),
      keymap(baseKeymap),
    ],
  })
}

/** A plugin chip's leading glyph: its logo, or a neutral fallback when it has none or fails to load. */
function pluginGlyph(logo: string | null): HTMLElement {
  const fallback = () => {
    const glyph = document.createElement('span')
    glyph.className = 'composer-chip-glyph'
    glyph.dataset.chipFallback = ''
    glyph.setAttribute('aria-hidden', 'true')
    return glyph
  }
  if (!logo) return fallback()
  const image = document.createElement('img')
  image.className = 'composer-chip-logo'
  image.src = logo
  image.alt = ''
  image.setAttribute('aria-hidden', 'true')
  image.addEventListener('error', () => image.replaceWith(fallback()), {
    once: true,
  })
  return image
}

onMounted(() => {
  view = new EditorView(host.value!, {
    state: createState(),
    attributes,
    nodeViews: {
      // The schema's toDOM, plus the plugin's logo in front of its name.
      chip: (node) => {
        const spec = node.type.spec.toDOM!(node)
        const { dom } = DOMSerializer.renderSpec(document, spec)
        if (node.attrs.kind === 'plugin')
          (dom as HTMLElement).prepend(
            pluginGlyph(
              props.catalog.pluginLogo?.(String(node.attrs.id)) ?? null,
            ),
          )
        return { dom, ignoreMutation: () => true }
      },
    },
    editable: () => !props.disabled,
    dispatchTransaction: dispatch,
    handleKeyDown: (_view, event) => {
      props.keydown?.(event)
      if (event.defaultPrevented) return true
      // Enter belongs to the controller (send or pick); it never splits a
      // line. An input method's Enter is left alone.
      return (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        event.keyCode !== 229
      )
    },
    handleTextInput: (current, _from, _to, text) => {
      if (text !== ' ') return false
      const typed = typedGestureAt(current.state, props.catalog)
      if (!typed) return false
      commitChip(
        current,
        typed.from,
        typed.to,
        typed.kind,
        typed.id,
        typed.label,
      )
      return true
    },
    handlePaste: (_view, event) => {
      if (event.clipboardData?.files.length) return false
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return false
      return pasteText(text)
    },
    // Dropped files belong to the composer's own drop handler.
    handleDrop: (_view, event) =>
      Boolean(event.dataTransfer?.types.includes('Files')),
    clipboardTextSerializer: (slice) => {
      let text = ''
      slice.content.forEach((block, _offset, index) => {
        if (index > 0) text += '\n'
        const visit = (node: PMNode): void => {
          if (node.type.name === 'chip')
            text += gestureOf(
              node.attrs.kind as ComposerReferenceKind,
              node.attrs.id as string,
            )
          else if (node.isText) text += node.text ?? ''
          else node.forEach(visit)
        }
        visit(block)
      })
      return text
    },
    handleDOMEvents: {
      focus: () => {
        emit('focus')
        return false
      },
    },
  })
  trackEditorView(view)
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// Placeholder, label and editability follow the props (setProps redraws).
watch(
  () => [props.placeholder, props.ariaLabel, props.disabled],
  () => view?.setProps({ attributes, editable: () => !props.disabled }),
)

function focus(): void {
  view?.focus()
}

/** Replace the whole draft (edit and resend, a restored draft, clearing). */
function setContent(
  text: string,
  references?: readonly ComposerReference[],
): void {
  if (!view) return
  const doc = composerDocFromText(text, props.catalog, references)
  const state = createState(doc)
  view.updateState(
    state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc))),
  )
  report(view.state, true)
}

function insertChip(
  kind: ComposerReferenceKind,
  id: string,
  label: string,
): void {
  if (!view) return
  const { from, to, $from } = view.state.selection
  // Keep a space between the chip and the text before it.
  const before = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 1),
    $from.parentOffset,
    undefined,
    '￼',
  )
  if (before !== '' && !/\s/.test(before)) {
    view.dispatch(view.state.tr.insertText(' ', from, to))
    const at = view.state.selection.from
    commitChip(view, at, at, kind, id, label)
  } else commitChip(view, from, to, kind, id, label)
  view.focus()
}

/** The typed `/query` (a trigger range) becomes a chip. */
function replaceWithChip(
  from: number,
  to: number,
  kind: ComposerReferenceKind,
  id: string,
  label: string,
): void {
  if (!view) return
  commitChip(view, from, to, kind, id, label)
  view.focus()
}

/** Complete known names typed as text become chips (before a send). */
function chipifyTyped(): void {
  if (!view) return
  const { content, references } = serializeComposer(view.state.doc)
  const rebuilt = composerDocFromText(content, props.catalog)
  const after = serializeComposer(rebuilt)
  if (after.references.length <= references.length) return
  // Keep the chips already there (their labels), add the typed ones.
  const labels = new Map(
    references.map((reference) => [reference.start, reference.label]),
  )
  const merged = after.references.map((reference) => ({
    ...reference,
    label: labels.get(reference.start) ?? reference.label,
  }))
  setContent(content, merged)
}

function output(): ComposerOutput {
  return view
    ? serializeComposer(view.state.doc)
    : { content: '', references: [] }
}

/** Dictation begins at the caret or selection as it is now. */
function dictationBegin(session: string): void {
  if (view) view.dispatch(beginDictation(view.state, session))
}

function dictationPartial(session: string, text: string): void {
  if (view) view.dispatch(showDictationPartial(view.state, session, text))
}

/** Inserts the final once, as one undo step; true when text went in. */
function dictationFinal(session: string, text: string): boolean {
  if (!view) return false
  const tr = commitDictation(view.state, session, text)
  if (!tr) return false
  view.dispatch(tr)
  view.dispatch(closeHistory(view.state.tr))
  return tr.docChanged
}

function dictationEnd(session: string): void {
  if (view) view.dispatch(endDictation(view.state, session))
}

defineExpose({
  focus,
  setContent,
  insertChip,
  replaceWithChip,
  chipifyTyped,
  output,
  dictationBegin,
  dictationPartial,
  dictationFinal,
  dictationEnd,
})
</script>

<template>
  <div
    ref="host"
    class="composer-editor"
    :data-hero="hero || undefined"
    :data-disabled="disabled || undefined"
  />
</template>

<style scoped>
.composer-editor :deep(.composer-url-decoration) {
  color: rgb(var(--accent-strong));
  text-decoration: underline;
  text-decoration-color: rgb(var(--accent-fill) / 0.3);
  text-underline-offset: 4px;
  border-radius: var(--radius-xs);
  background: transparent;
}
.composer-editor :deep(.composer-url-decoration::before) {
  content: '';
  display: inline-block;
  width: 1em;
  height: 1em;
  margin-inline: var(--space-1) var(--space-1-5);
  vertical-align: -0.1em;
  background: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18'/%3E%3C/svg%3E")
    center/contain no-repeat;
}
.composer-editor :deep(.composer-url-decoration[data-site-letter]::before) {
  content: attr(data-site-letter) / '';
  mask: none;
  background: rgb(var(--accent-fill) / 0.14);
  border-radius: var(--radius-xs);
  font: 600 0.7em/1.4 var(--font-sans);
  text-align: center;
}
.composer-editor
  :deep(.composer-url-decoration[data-resource-kind='github']::before) {
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7'%3E%3Cpath d='M9 19c-4 1-4-2-6-3m12 6v-4c0-1-.3-2-1-2.6 3-.3 6-1.4 6-6.5 0-1.4-.5-2.7-1.4-3.7.3-1.2.3-2.4-.2-3.6 0 0-1.2-.4-3.6 1.4a13 13 0 0 0-7 0C5.4 1.2 4.2 1.6 4.2 1.6c-.5 1.2-.5 2.4-.2 3.6a5.5 5.5 0 0 0-1.4 3.7c0 5.1 3 6.2 6 6.5-.7.6-1 1.6-1 2.6v4'/%3E%3C/svg%3E");
}
.composer-editor {
  min-width: 0;
}
.composer-editor
  :deep(.composer-url-decoration[data-site-icon='ready']::before) {
  content: '';
  mask: none;
  background: rgb(var(--nb-00)) var(--composer-site-icon) center / contain
    no-repeat;
  border-radius: var(--radius-xs);
}

.composer-editor :deep(.composer-editor-input) {
  box-sizing: border-box;
  min-height: var(--space-7);
  max-height: 336px;
  margin: 0;
  padding: var(--space-1) var(--space-3) 0 var(--space-4);
  overflow-y: auto;
  outline: none;
  color: rgb(var(--label-primary));
  caret-color: rgb(var(--caret));
  font-family: var(--font-sans);
  font-size: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.composer-editor[data-hero] :deep(.composer-editor-input) {
  min-height: 52px;
}

.composer-editor[data-disabled] :deep(.composer-editor-input) {
  cursor: not-allowed;
  opacity: 0.6;
}

.composer-editor :deep(.composer-editor-input p) {
  margin: 0;
}

/* ProseMirror ends a line that ends in a chip or the dictation draft with
   an empty image for the caret. The base styles make images blocks, which
   pushed an extra empty line under it; it stays inline, as in
   prosemirror-view's own stylesheet. */
.composer-editor :deep(img.ProseMirror-separator) {
  display: inline;
  border: none;
  margin: 0;
}

.composer-editor :deep(.composer-editor-empty)::before {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  color: rgb(var(--label-caption));
  pointer-events: none;
}

/* Dictation (dictationDraft.ts): what is being heard, not yet text. */
.composer-editor :deep(.composer-dictation-draft) {
  color: rgb(var(--label-tertiary));
  text-decoration: underline dotted rgb(var(--label-tertiary));
  text-underline-offset: 0.2em;
  pointer-events: none;
  user-select: none;
}

.composer-editor :deep(.composer-dictation-draft:empty)::after {
  content: '…';
}

.composer-editor :deep(.composer-dictation-replaced) {
  color: rgb(var(--label-tertiary));
  text-decoration: line-through;
}

.composer-editor :deep(.composer-chip) {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-1);
  margin: 0 var(--space-0-5);
  border-radius: var(--radius-cell);
  background: rgb(var(--accent-fill) / 0.12);
  color: rgb(var(--accent-strong));
  font-weight: 500;
  white-space: nowrap;
  vertical-align: baseline;
  cursor: default;
  user-select: none;
}

.composer-editor :deep(.composer-chip[data-kind='skill'])::before {
  content: '';
  flex: none;
  width: 0.875em;
  height: 0.875em;
  background-color: currentColor;
  -webkit-mask: var(--composer-chip-icon) center / contain no-repeat;
  mask: var(--composer-chip-icon) center / contain no-repeat;
}

.composer-editor :deep(.composer-chip-logo) {
  flex: none;
  width: 1em;
  height: 1em;
  border-radius: 2px;
  object-fit: cover;
}

/* A plugin without a usable logo: a neutral block glyph. */
.composer-editor :deep(.composer-chip-glyph) {
  flex: none;
  width: 0.875em;
  height: 0.875em;
  background-color: currentColor;
  -webkit-mask: var(--composer-plugin-icon) center / contain no-repeat;
  mask: var(--composer-plugin-icon) center / contain no-repeat;
  --composer-plugin-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='14' y='3' width='7' height='7' rx='1'/%3E%3Cpath d='M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3'/%3E%3C/svg%3E");
}

.composer-editor :deep(.composer-chip[data-kind='skill']) {
  --composer-chip-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='black' d='M12.5 15.4c-.07.22-.38.22-.45 0l-.42-1.26a2.5 2.5 0 0 0-1.2-1.2l-1.27-.43c-.22-.07-.22-.38 0-.45l1.27-.42a2.5 2.5 0 0 0 1.2-1.2l.42-1.27c.07-.22.38-.22.45 0l.42 1.27a2.5 2.5 0 0 0 1.2 1.2l1.27.42c.22.07.22.38 0 .45l-1.27.42a2.5 2.5 0 0 0-1.2 1.2l-.42 1.27Z'/%3E%3Cpath fill='black' d='M9 .55c.98 0 1.75 0 2.37.06.63.07 1.18.21 1.66.56.28.2.52.45.72.72.35.48.49 1.03.56 1.66.07.62.07 1.39.07 2.36v2.61a4.4 4.4 0 0 0-1.35-.45V5.9c0-.99 0-1.68-.06-2.2-.06-.52-.16-.8-.31-1.01a1.3 1.3 0 0 0-.43-.43c-.2-.15-.49-.25-1-.3-.53-.06-1.22-.06-2.2-.06H6.55c-.99 0-1.68 0-2.2.06-.52.05-.8.15-1.01.3a1.3 1.3 0 0 0-.43.43c-.15.2-.25.49-.31 1-.06.53-.06 1.22-.06 2.21v4.2c0 .99 0 1.68.06 2.2.06.52.16.8.31 1.01.12.16.26.3.43.43.2.15.49.25 1 .31.53.06 1.22.06 2.21.06h1.53c.19.5.47.96.81 1.35H6.55c-.96 0-1.73 0-2.35-.07-.63-.07-1.18-.21-1.65-.56a2.7 2.7 0 0 1-.73-.72c-.34-.48-.49-1.03-.56-1.66-.06-.62-.06-1.39-.06-2.35V5.9c0-.96 0-1.73.06-2.35.07-.63.22-1.18.56-1.66.2-.27.45-.52.73-.72.47-.35 1.02-.49 1.65-.56C4.82.55 5.6.55 6.55.55H9Zm.2 8.6H4.55V7.85H9.2v1.3Zm1.83-3.04H4.55V4.8h6.48v1.3Z'/%3E%3C/svg%3E");
}
</style>
