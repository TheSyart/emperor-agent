<script setup lang="ts">
/**
 * IconButton — a glyph-only button (DS-03).
 *   size:    xs 20 | sm 28 (default) | md 32
 *   variant: ghost (default) | tonal (neutral fill) | primary (gold; send)
 *   shape:   square (radius 8, default) | circle
 * `label` is required (accessible name and tooltip text); the tooltip is a
 * real Tooltip bubble with an optional `shortcut`, never a native title.
 * `tooltip: false` keeps the accessible name without a bubble.
 */
import { computed, ref } from 'vue'
import TooltipBubble from './TooltipBubble.vue'
import { useTooltip } from './useTooltip'

const props = withDefaults(
  defineProps<{
    label: string
    size?: 'xs' | 'sm' | 'md'
    variant?: 'ghost' | 'tonal' | 'primary'
    shape?: 'square' | 'circle'
    active?: boolean
    disabled?: boolean
    tooltip?: string | false
    shortcut?: string
    side?: 'top' | 'bottom' | 'right'
    type?: 'button' | 'submit'
  }>(),
  {
    size: 'sm',
    variant: 'ghost',
    shape: 'square',
    active: false,
    disabled: false,
    tooltip: undefined,
    shortcut: '',
    side: 'top',
    type: 'button',
  },
)

if (import.meta.env.DEV && !props.label)
  console.error('IconButton needs a label (its accessible name and tooltip)')

const anchor = ref<HTMLButtonElement | null>(null)
const tooltipText = computed(() =>
  props.tooltip === false ? '' : (props.tooltip ?? props.label),
)
const { visible, position, listeners } = useTooltip({
  anchor,
  side: () => props.side,
  delayMs: () => 400,
  enabled: () => Boolean(tooltipText.value),
})
</script>

<template>
  <button
    ref="anchor"
    :type="type"
    class="ds-icon-button"
    :data-size="size"
    :data-variant="variant"
    :data-shape="shape"
    :data-active="active || undefined"
    :aria-label="label"
    :disabled="disabled"
    v-on="listeners"
  >
    <slot />
    <!-- Teleported to <body>; inside the button only so it stays one root. -->
    <TooltipBubble
      v-if="visible"
      :label="tooltipText"
      :shortcut="shortcut"
      :side="side"
      :position="position"
    />
  </button>
</template>

<style scoped>
.ds-icon-button {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: var(--control-sm);
  height: var(--control-sm);
  padding: 0;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: rgb(var(--text-2));
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.ds-icon-button[data-size='xs'] {
  width: var(--control-xs);
  height: var(--control-xs);
  border-radius: var(--r-xs);
}

.ds-icon-button[data-size='md'] {
  width: var(--control-md);
  height: var(--control-md);
}

.ds-icon-button[data-shape='circle'] {
  border-radius: var(--r-full);
}

.ds-icon-button[data-variant='ghost']:hover:not(:disabled),
.ds-icon-button[data-variant='ghost'][data-active] {
  background: var(--surface-hover);
  color: rgb(var(--text-1));
}

.ds-icon-button[data-variant='tonal'] {
  background: var(--surface-active);
  color: rgb(var(--text-1));
}

.ds-icon-button[data-variant='tonal']:hover:not(:disabled),
.ds-icon-button[data-variant='tonal'][data-active] {
  background: var(--surface-hover-strong);
}

.ds-icon-button[data-variant='primary'] {
  background: rgb(var(--accent));
  color: rgb(var(--text-on-accent));
}

.ds-icon-button[data-variant='primary']:hover:not(:disabled) {
  background: rgb(var(--accent-hover));
}

.ds-icon-button:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

.ds-icon-button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
