<script setup lang="ts">
/**
 * StatusBadge — compact status / tag pill (dsh configTag / pending: 20px,
 * 11/16 medium). Tones map to the --state-* family: ok (green), warn
 * (amber), error (red), neutral (translucent fill, secondary label), accent
 * (Emperor gold).
 *
 * Props:
 * - tone (default 'neutral').
 * - label?: text (or the default slot).
 * - dot?: leading 6px dot in the tone's base color.
 * - mono?: monospace text (versions, transports, ids).
 * Slots: default (label).
 */
withDefaults(
  defineProps<{
    tone?: 'ok' | 'warn' | 'error' | 'neutral' | 'accent'
    label?: string
    dot?: boolean
    mono?: boolean
  }>(),
  { tone: 'neutral', label: undefined, dot: false, mono: false },
)
</script>

<template>
  <span
    class="ds-status-badge"
    :data-tone="tone"
    :data-mono="mono || undefined"
  >
    <span v-if="dot" class="badge-dot" aria-hidden="true" />
    <slot>{{ label }}</slot>
  </span>
</template>

<style scoped>
.ds-status-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  min-height: var(--space-5);
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  overflow: hidden;
  font-size: var(--fs-xxxs);
  line-height: var(--space-4);
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
  /* translucent so the neutral pill reads on the panel and on cards alike */
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}

.ds-status-badge[data-mono] {
  font-family: var(--font-mono);
  font-weight: 400;
}

.badge-dot {
  flex: none;
  width: var(--space-1-5);
  height: var(--space-1-5);
  border-radius: var(--radius-pill);
  background: rgb(var(--label-tertiary));
}

.ds-status-badge[data-tone='ok'] {
  background: rgb(var(--state-ok-soft));
  color: rgb(var(--state-ok-label));
}

.ds-status-badge[data-tone='ok'] .badge-dot {
  background: rgb(var(--state-ok));
}

.ds-status-badge[data-tone='warn'] {
  background: rgb(var(--state-warn-soft));
  color: rgb(var(--state-warn-label));
}

.ds-status-badge[data-tone='warn'] .badge-dot {
  background: rgb(var(--state-warn));
}

.ds-status-badge[data-tone='error'] {
  background: rgb(var(--state-error-soft));
  color: rgb(var(--state-error-label));
}

.ds-status-badge[data-tone='error'] .badge-dot {
  background: rgb(var(--state-error));
}

.ds-status-badge[data-tone='accent'] {
  background: rgb(var(--accent-soft));
  color: rgb(var(--accent-strong));
}

.ds-status-badge[data-tone='accent'] .badge-dot {
  background: rgb(var(--accent-fill));
}
</style>
