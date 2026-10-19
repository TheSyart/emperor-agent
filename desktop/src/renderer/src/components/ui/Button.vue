<script setup lang="ts">
/**
 * Button — capsule text button (DS-03).
 *   variant: primary   gold fill; at most one per container (dev warning)
 *            secondary neutral fill (replaces the old outline buttons)
 *            ghost     transparent until hovered (default)
 *            danger    for confirming destructive actions only
 *   size:    sm 28 | md 32 (default) | lg 40
 * `loading` shows a Spinner and blocks clicks. Slots: `icon` (leading
 * 16px glyph), default (label).
 */
import { onMounted, ref } from 'vue'
import Spinner from './Spinner.vue'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    disabled?: boolean
    loading?: boolean
    type?: 'button' | 'submit'
  }>(),
  {
    variant: 'ghost',
    size: 'md',
    disabled: false,
    loading: false,
    type: 'button',
  },
)

const element = ref<HTMLButtonElement | null>(null)

onMounted(() => {
  if (!import.meta.env.DEV || props.variant !== 'primary') return
  const parent = element.value?.parentElement
  if (!parent) return
  const primaries = [
    ...parent.querySelectorAll(':scope > .ds-button[data-variant="primary"]'),
  ]
  if (primaries.length > 1 && primaries[0] !== element.value)
    console.warn(
      'Button: more than one primary Button in one container; keep one gold action per screen',
    )
})
</script>

<template>
  <button
    ref="element"
    :type="type"
    class="ds-button"
    :data-variant="variant"
    :data-size="size"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
  >
    <Spinner v-if="loading" size="sm" :tone="'neutral'" class="icon" />
    <span v-else-if="$slots.icon" class="icon"><slot name="icon" /></span>
    <slot />
  </button>
</template>

<style scoped>
.ds-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1-5);
  flex: none;
  height: var(--control-md);
  padding: 0 var(--space-3-5);
  border: none;
  border-radius: var(--r-full);
  background: transparent;
  color: rgb(var(--text-1));
  font: var(--weight-medium) var(--type-footnote) var(--font-sans);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.ds-button[data-size='sm'] {
  height: var(--control-sm);
  padding: 0 var(--space-2-5);
  font: var(--weight-medium) var(--type-caption) var(--font-sans);
}

.ds-button[data-size='lg'] {
  height: var(--control-lg);
  padding: 0 var(--space-4);
  font: var(--weight-medium) var(--type-body-sm) var(--font-sans);
}

.ds-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ds-button[aria-busy='true'] {
  cursor: progress;
}

.ds-button:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.ds-button[data-variant='primary'] {
  background: rgb(var(--accent));
  color: rgb(var(--text-on-accent));
}

.ds-button[data-variant='primary']:hover:not(:disabled) {
  background: rgb(var(--accent-hover));
}

.ds-button[data-variant='secondary'] {
  background: var(--surface-active);
}

.ds-button[data-variant='secondary']:hover:not(:disabled),
.ds-button[data-variant='ghost']:hover:not(:disabled) {
  background: var(--surface-hover-strong);
}

.ds-button[data-variant='ghost'] {
  color: rgb(var(--text-2));
}

.ds-button[data-variant='ghost']:hover:not(:disabled) {
  background: var(--surface-hover);
  color: rgb(var(--text-1));
}

.ds-button[data-variant='danger'] {
  background: rgb(var(--error-soft));
  color: rgb(var(--error));
}

.ds-button[data-variant='danger']:hover:not(:disabled) {
  background: var(--surface-hover-danger);
}

.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-md);
  height: var(--icon-md);
}
</style>
