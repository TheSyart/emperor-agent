<script setup lang="ts">
/**
 * IconButton — dsh round icon button.
 *
 * Props:
 * - label: accessible name (also the native tooltip unless `tooltip` = false).
 * - size: 28 (ghost, radius 8 — toolbars/headers) | 34 (round primary — send).
 * - variant: 'ghost' (transparent, hover fill) | 'primary' (gold fill) |
 *   'contrast' (black/white fill).
 * - round?: force a circle for the 28 size.
 * - disabled?, active?.
 */
withDefaults(
  defineProps<{
    label: string
    size?: 28 | 34
    variant?: 'ghost' | 'primary' | 'contrast'
    round?: boolean
    active?: boolean
    disabled?: boolean
  }>(),
  {
    size: 28,
    variant: 'ghost',
    round: false,
    active: false,
    disabled: false,
  },
)
</script>

<template>
  <button
    type="button"
    class="ds-icon-button"
    :data-size="size"
    :data-variant="variant"
    :data-round="round || size === 34 || undefined"
    :data-active="active || undefined"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.ds-icon-button {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-secondary));
  cursor: pointer;
  transition:
    background-color var(--duration-ds-fast) ease,
    color var(--duration-ds-fast) ease;
}

.ds-icon-button[data-size='34'] {
  width: calc(var(--space-8) + 2px);
  height: calc(var(--space-8) + 2px);
}

.ds-icon-button[data-round] {
  border-radius: var(--radius-pill);
}

.ds-icon-button[data-variant='ghost']:hover:not(:disabled),
.ds-icon-button[data-variant='ghost'][data-active] {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.ds-icon-button[data-variant='primary'] {
  background: rgb(var(--accent-fill));
  color: rgb(var(--accent-fg));
}

.ds-icon-button[data-variant='primary']:hover:not(:disabled) {
  background: rgb(var(--accent-hover));
}

.ds-icon-button[data-variant='contrast'] {
  background: rgb(var(--button-primary-fill));
  color: rgb(var(--button-primary-fg));
}

.ds-icon-button[data-variant='contrast']:hover:not(:disabled) {
  background: rgb(var(--button-primary-hover));
}

.ds-icon-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.ds-icon-button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
