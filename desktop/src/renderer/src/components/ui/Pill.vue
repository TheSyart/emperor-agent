<script setup lang="ts">
/**
 * Pill — dsh 24px rounded chip (12/18 secondary on layer-2). Renders a button
 * when `interactive` (or when a click listener is expected), else a span.
 *
 * Props:
 * - active?: selected look (ghost-active fill + inset border).
 * - interactive?: render as a hoverable <button>.
 * - tone?: 'default' | 'accent' | 'approval' | 'danger'.
 */
withDefaults(
  defineProps<{
    active?: boolean
    interactive?: boolean
    tone?: 'default' | 'accent' | 'approval' | 'danger'
  }>(),
  { active: false, interactive: false, tone: 'default' },
)
</script>

<template>
  <component
    :is="interactive ? 'button' : 'span'"
    :type="interactive ? 'button' : undefined"
    class="ds-pill"
    :data-active="active || undefined"
    :data-interactive="interactive || undefined"
    :data-tone="tone"
  >
    <slot />
  </component>
</template>

<style scoped>
.ds-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--space-6);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-card);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  background: rgb(var(--bg-layer-2));
  white-space: nowrap;
}

[data-theme='light'] .ds-pill {
  background: rgb(var(--nb-75));
}

.ds-pill[data-interactive] {
  cursor: pointer;
}

.ds-pill[data-interactive]:hover {
  background: var(--interactive-bg-hover);
}

.ds-pill[data-active] {
  color: rgb(var(--label-primary));
  background: rgb(var(--ghost-active-fill));
  box-shadow: inset 0 0 0 1px rgb(var(--ghost-active-border));
}

.ds-pill[data-tone='accent'] {
  color: rgb(var(--accent-strong));
  background: rgb(var(--accent-soft));
}

.ds-pill[data-tone='approval'] {
  color: rgb(var(--approval-line));
  background: rgb(var(--approval-soft));
}

.ds-pill[data-tone='danger'] {
  color: rgb(var(--danger));
  background: rgb(var(--danger-soft));
}
</style>
