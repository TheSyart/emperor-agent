<script setup lang="ts">
/**
 * Tag — an interactive 28px capsule (DS-04): a filter, an attachment, a
 * reference. `selected` marks a filter as on (aria-pressed); `removable`
 * adds a × button and lets Backspace / Delete remove the focused tag.
 *
 * Props: label (or the default slot), selected?, removable?, disabled?,
 * removeLabel (default 「移除」, read as 「移除 <label>」).
 * Slots: leading (a 16px thumbnail or glyph), default (label).
 * Emits: click, remove.
 */
import { computed } from 'vue'
import { DsClose } from '../icons/ds'

const props = withDefaults(
  defineProps<{
    label?: string
    selected?: boolean
    removable?: boolean
    disabled?: boolean
    removeLabel?: string
  }>(),
  {
    label: '',
    selected: undefined,
    removable: false,
    disabled: false,
    removeLabel: '移除',
  },
)

const emit = defineEmits<{ click: [event: MouseEvent]; remove: [] }>()

const removeName = computed(() =>
  [props.removeLabel, props.label].filter(Boolean).join(' '),
)

function onKeydown(event: KeyboardEvent) {
  if (!props.removable || props.disabled) return
  if (event.key !== 'Backspace' && event.key !== 'Delete') return
  event.preventDefault()
  emit('remove')
}
</script>

<template>
  <span
    class="ds-tag"
    :data-selected="selected || undefined"
    :data-removable="removable || undefined"
    :data-disabled="disabled || undefined"
  >
    <button
      type="button"
      class="body"
      :disabled="disabled"
      :aria-pressed="selected"
      @click="emit('click', $event)"
      @keydown="onKeydown"
    >
      <span v-if="$slots.leading" class="leading"><slot name="leading" /></span>
      <span class="label"
        ><slot>{{ label }}</slot></span
      >
    </button>
    <button
      v-if="removable"
      type="button"
      class="remove"
      tabindex="-1"
      :disabled="disabled"
      :aria-label="removeName"
      @click.stop="emit('remove')"
    >
      <DsClose :size="12" />
    </button>
  </span>
</template>

<style scoped>
.ds-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  max-width: 100%;
  height: var(--control-sm);
  border-radius: var(--r-full);
  background: var(--surface-active);
  color: rgb(var(--text-2));
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.ds-tag:hover:not([data-disabled]) {
  background: var(--surface-hover-strong);
  color: rgb(var(--text-1));
}

.ds-tag[data-selected] {
  background: rgb(var(--surface-selected));
  color: rgb(var(--text-1));
  box-shadow: inset 0 0 0 0.5px var(--stroke-3);
}

.ds-tag[data-disabled] {
  opacity: 0.4;
}

.ds-tag:has(.body:focus-visible) {
  box-shadow:
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.body {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  height: 100%;
  padding: 0 var(--space-3);
  border: none;
  border-radius: inherit;
  outline: none;
  background: transparent;
  color: inherit;
  font: var(--weight-medium) var(--type-caption) var(--font-sans);
  white-space: nowrap;
  cursor: pointer;
}

.ds-tag[data-removable] .body {
  padding-right: var(--space-1);
}

.body:disabled {
  cursor: default;
}

.leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--icon-md);
  height: var(--icon-md);
  overflow: hidden;
  border-radius: var(--r-xs);
}

.leading :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.remove {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: var(--control-xs);
  height: var(--control-xs);
  margin-right: var(--space-1);
  padding: 0;
  border: none;
  border-radius: var(--r-full);
  background: transparent;
  color: rgb(var(--text-3));
  cursor: pointer;
}

.remove:hover:not(:disabled) {
  background: var(--surface-hover-strong);
  color: rgb(var(--text-1));
}
</style>
