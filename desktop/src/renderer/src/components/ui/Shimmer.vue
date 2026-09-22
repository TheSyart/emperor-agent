<script setup lang="ts">
/**
 * Shimmer — gradient text shimmer (dsh TurnStatus). Gold by default; the
 * neutral tone sweeps tertiary→primary for secondary rows. Reduced motion
 * falls back to static text (styles/a11y.css).
 *
 * Props:
 * - text?: content (or use the default slot).
 * - tone: 'accent' (default) | 'neutral'.
 * - active (default true): false renders plain text.
 */
withDefaults(
  defineProps<{
    text?: string
    tone?: 'accent' | 'neutral'
    active?: boolean
  }>(),
  { text: undefined, tone: 'accent', active: true },
)
</script>

<template>
  <span
    :class="['ds-shimmer-text', { 'ds-shimmer': active }]"
    :data-tone="tone"
  >
    <slot>{{ text }}</slot>
  </span>
</template>

<style scoped>
.ds-shimmer-text {
  display: inline-flex;
  align-items: center;
  font: var(--font-s);
  font-weight: 500;
  white-space: nowrap;
}

.ds-shimmer-text:not(.ds-shimmer) {
  color: rgb(var(--label-secondary));
}
</style>
