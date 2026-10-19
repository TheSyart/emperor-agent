<script setup lang="ts">
/**
 * Badge — a static 18px label for a status, a count or a tag (DS-04).
 *   tone:    neutral (default) | accent | ok | warn | error | attention |
 *            info
 *   variant: soft      tinted pill (default)
 *            count     a number in tabular figures
 *            dot-label a 6px dot in the tone colour before plain text
 * `label` is the text or number (or use the default slot); `mono` sets the
 * code font (versions, transports, ids). Status uses ok / warn / error /
 * attention / info; accent (gold) is only for the rare brand or selection
 * mark.
 */
withDefaults(
  defineProps<{
    tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'error' | 'attention' | 'info'
    variant?: 'soft' | 'count' | 'dot-label'
    label?: string | number
    mono?: boolean
  }>(),
  { tone: 'neutral', variant: 'soft', label: undefined, mono: false },
)
</script>

<template>
  <span
    class="ds-badge"
    :data-tone="tone"
    :data-variant="variant"
    :data-mono="mono || undefined"
  >
    <span v-if="variant === 'dot-label'" class="badge-dot" aria-hidden="true" />
    <slot>{{ label }}</slot>
  </span>
</template>

<style scoped>
.ds-badge {
  --badge-fill: var(--surface-active);
  --badge-ink: var(--text-2);
  --badge-dot: var(--text-3);
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  height: var(--badge-h);
  padding: 0 var(--space-1-5);
  border-radius: var(--r-full);
  overflow: hidden;
  background: var(--badge-fill);
  color: rgb(var(--badge-ink));
  font-family: var(--font-sans);
  font-size: var(--fs-xxxs);
  line-height: var(--badge-h);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ds-badge[data-tone='accent'] {
  --badge-fill: rgb(var(--accent-soft));
  --badge-ink: var(--text-link);
  --badge-dot: var(--accent);
}

.ds-badge[data-tone='ok'] {
  --badge-fill: rgb(var(--ok-soft));
  --badge-ink: var(--state-ok-label);
  --badge-dot: var(--ok);
}

.ds-badge[data-tone='warn'] {
  --badge-fill: rgb(var(--warn-soft));
  --badge-ink: var(--state-warn-label);
  --badge-dot: var(--warn);
}

.ds-badge[data-tone='error'] {
  --badge-fill: rgb(var(--error-soft));
  --badge-ink: var(--state-error-label);
  --badge-dot: var(--error);
}

.ds-badge[data-tone='attention'] {
  --badge-fill: rgb(var(--attention-soft));
  --badge-ink: var(--attention);
  --badge-dot: var(--attention);
}

.ds-badge[data-tone='info'] {
  --badge-fill: rgb(var(--info-soft));
  --badge-ink: var(--info);
  --badge-dot: var(--info);
}

.ds-badge[data-variant='count'] {
  justify-content: center;
  min-width: var(--badge-h);
  padding: 0 var(--space-1);
  font-variant-numeric: tabular-nums;
}

.ds-badge[data-variant='dot-label'] {
  padding: 0;
  background: transparent;
  color: rgb(var(--text-2));
  font-weight: var(--weight-regular);
}

.ds-badge[data-mono] {
  font-family: var(--font-mono);
  font-weight: var(--weight-regular);
}

.badge-dot {
  flex: none;
  width: var(--dot-sm);
  height: var(--dot-sm);
  border-radius: var(--r-full);
  background: rgb(var(--badge-dot));
}
</style>
