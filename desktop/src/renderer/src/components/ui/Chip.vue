<script setup lang="ts">
/**
 * Chip — dsh composer trigger chip (28px, radius 24, 13/20 medium
 * secondary; hover = interactive-bg). Used for permission / plan / model
 * triggers.
 *
 * Props:
 * - tone?: 'default' | 'approval' (amber plan capsule) | 'accent'.
 * - active?: pressed/selected look.
 * - disabled?: dimmed, not interactive.
 * - chevron?: trailing caption chevron (menu trigger).
 * Slots: `icon` (14px glyph), default (label).
 */
import { DsChevronDown } from '../icons/ds'

withDefaults(
  defineProps<{
    tone?: 'default' | 'approval' | 'accent'
    active?: boolean
    disabled?: boolean
    chevron?: boolean
  }>(),
  { tone: 'default', active: false, disabled: false, chevron: false },
)
</script>

<template>
  <button
    type="button"
    class="ds-chip"
    :data-tone="tone"
    :data-active="active || undefined"
    :disabled="disabled"
  >
    <span v-if="$slots.icon" class="icon"><slot name="icon" /></span>
    <span class="label"><slot /></span>
    <DsChevronDown v-if="chevron" :size="14" class="chevron" />
  </button>
</template>

<style scoped>
.ds-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  max-width: 220px;
  height: var(--space-7);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  outline: none;
  background: transparent;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.ds-chip:has(.chevron) {
  padding-right: var(--space-1);
}

.ds-chip:hover:not(:disabled),
.ds-chip[data-active] {
  background: var(--interactive-bg-hover);
}

.ds-chip:focus-visible {
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.ds-chip:disabled {
  color: rgb(var(--label-dimmed));
  cursor: default;
}

.ds-chip[data-tone='approval'] {
  color: rgb(var(--approval-line));
  background: rgb(var(--approval-soft));
  box-shadow: inset 0 0 0 1px rgb(var(--approval) / 0.35);
}

.ds-chip[data-tone='approval']:hover:not(:disabled) {
  background: rgb(var(--approval) / 0.16);
}

.ds-chip[data-tone='accent'] {
  color: rgb(var(--accent-strong));
  background: rgb(var(--accent-soft));
}

.icon {
  display: inline-flex;
  flex: none;
}

.icon :deep(svg) {
  width: var(--space-3-5);
  height: var(--space-3-5);
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron {
  flex: none;
  color: rgb(var(--label-caption));
}
</style>
