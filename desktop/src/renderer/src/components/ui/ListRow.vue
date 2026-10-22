<script setup lang="ts">
/**
 * ListRow — one row of a list (DS-04): a leading glyph, the title, an
 * optional subtitle, meta text and trailing actions that show only while
 * the row is hovered or has keyboard focus.
 *   size: sm 32 (default) | md 40 | lg 52
 *   selected · nested (indented one step) · danger (error text) · disabled
 *   wrap: the row grows with its text — title and subtitle wrap instead of
 *   ending in an ellipsis, the leading glyph stays on the first line
 * Keyboard: ArrowUp / ArrowDown / Home / End move between the rows of the
 * same list; Enter / Space select. A click selects too, except on the
 * trailing actions. Inside <List> the row is an option of the listbox.
 *
 * Props: title (or the default slot), subtitle?, plus the flags above.
 * Slots: leading, default (title), subtitle, meta, trailing.
 * Emits: select.
 */
import { computed, ref } from 'vue'
import { siblingRows, useList } from './listContext'

const props = withDefaults(
  defineProps<{
    title?: string
    subtitle?: string
    size?: 'sm' | 'md' | 'lg'
    selected?: boolean
    nested?: boolean
    danger?: boolean
    disabled?: boolean
    wrap?: boolean
  }>(),
  {
    title: '',
    subtitle: '',
    size: 'sm',
    selected: false,
    nested: false,
    danger: false,
    disabled: false,
    wrap: false,
  },
)

const emit = defineEmits<{ select: [event: Event] }>()
const list = useList()
const hovered = ref(false)
const focused = ref(false)
const reveal = computed(() => hovered.value || focused.value)

function select(event: Event) {
  if (props.disabled) return
  emit('select', event)
}

function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('.trailing')) return
  select(event)
}

function onKeydown(event: KeyboardEvent) {
  const row = event.currentTarget as HTMLElement
  // Keys typed into a control inside the row belong to that control.
  if (event.target !== row) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    select(event)
    return
  }
  const rows = siblingRows(row)
  const at = rows.indexOf(row)
  let next: HTMLElement | undefined
  if (event.key === 'ArrowDown') next = rows[at + 1]
  else if (event.key === 'ArrowUp') next = rows[at - 1]
  else if (event.key === 'Home') next = rows[0]
  else if (event.key === 'End') next = rows[rows.length - 1]
  else return
  event.preventDefault()
  next?.focus()
}

function onFocusOut(event: FocusEvent) {
  const row = event.currentTarget as HTMLElement
  const to = event.relatedTarget as Node | null
  if (to && row.contains(to)) return
  focused.value = false
}
</script>

<template>
  <div
    class="ds-list-row"
    :role="list ? 'option' : 'button'"
    :tabindex="disabled ? -1 : 0"
    :data-size="size"
    :data-selected="selected || undefined"
    :data-nested="nested || undefined"
    :data-danger="danger || undefined"
    :data-wrap="wrap || undefined"
    :data-reveal="reveal || undefined"
    :aria-selected="list ? selected : undefined"
    :aria-pressed="list ? undefined : selected || undefined"
    :aria-disabled="disabled || undefined"
    @click="onClick"
    @keydown="onKeydown"
    @pointerenter="hovered = true"
    @pointerleave="hovered = false"
    @focusin="focused = true"
    @focusout="onFocusOut"
  >
    <span v-if="$slots.leading" class="leading"><slot name="leading" /></span>
    <span class="text">
      <span class="title"
        ><slot>{{ title }}</slot></span
      >
      <span v-if="$slots.subtitle || subtitle" class="subtitle">
        <slot name="subtitle">{{ subtitle }}</slot>
      </span>
    </span>
    <span v-if="$slots.meta" class="meta"><slot name="meta" /></span>
    <span v-if="$slots.trailing" class="trailing"
      ><slot name="trailing"
    /></span>
  </div>
</template>

<style scoped>
.ds-list-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: var(--list-row-sm);
  padding: 0 var(--space-2);
  border-radius: var(--r-sm);
  outline: none;
  color: rgb(var(--text-1));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  cursor: pointer;
  user-select: none;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.ds-list-row[data-size='md'] {
  height: var(--list-row-md);
}

.ds-list-row[data-size='lg'] {
  height: var(--list-row-lg);
  padding: 0 var(--space-3);
}

.ds-list-row[data-wrap] {
  align-items: flex-start;
  height: auto;
  min-height: var(--list-row-sm);
  padding-block: var(--space-2);
}

.ds-list-row[data-nested] {
  padding-left: calc(var(--space-2) + var(--space-5));
}

.ds-list-row:hover:not([aria-disabled='true']) {
  background: var(--surface-hover);
}

.ds-list-row[data-selected] {
  background: rgb(var(--surface-selected));
}

.ds-list-row[data-danger] {
  color: rgb(var(--error));
}

.ds-list-row[aria-disabled='true'] {
  color: rgb(var(--text-disabled));
  cursor: default;
}

.ds-list-row:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.55);
}

.leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: var(--icon-md);
  color: rgb(var(--text-2));
}

.ds-list-row[data-wrap] .leading {
  height: var(--lh-xs);
}

.ds-list-row[data-danger] .leading {
  color: inherit;
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.title,
.subtitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtitle {
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.ds-list-row[data-wrap] .title,
.ds-list-row[data-wrap] .subtitle {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}

.meta {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  font-variant-numeric: tabular-nums;
}

.trailing {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast) var(--ease-standard);
}

.ds-list-row[data-reveal] .trailing {
  opacity: 1;
  pointer-events: auto;
}
</style>
