<script setup lang="ts">
/**
 * Metric — one stat tile (dsh token-usage metrics): r8 l1-bordered tile on
 * the panel fill, 12/18 secondary label (single line, ellipsis), 18px
 * semibold tabular value with an optional unit, 11/14 tertiary hint. Lay
 * tiles out with CSS grid, e.g. `repeat(auto-fit, minmax(120px, 1fr))`.
 *
 * Props:
 * - label: what is measured.
 * - value: the number / text (formatted by the caller).
 * - unit?: small suffix after the value (「次」「ms」).
 * - hint?: context line (「近 30 天」「较上周 +12%」).
 * - tone: 'default' | 'ok' | 'warn' | 'error' | 'accent' (value color).
 * Slots: `value` (custom value rendering), `hint`.
 */
withDefaults(
  defineProps<{
    label: string
    value?: string | number
    unit?: string
    hint?: string
    tone?: 'default' | 'ok' | 'warn' | 'error' | 'accent'
  }>(),
  { value: undefined, unit: undefined, hint: undefined, tone: 'default' },
)
</script>

<template>
  <div class="ds-metric" :data-tone="tone">
    <span class="label" :title="label">{{ label }}</span>
    <span class="value">
      <slot name="value">{{ value ?? '—' }}</slot>
      <span v-if="unit" class="unit">{{ unit }}</span>
    </span>
    <span v-if="$slots.hint || hint" class="hint">
      <slot name="hint">{{ hint }}</slot>
    </span>
  </div>
</template>

<style scoped>
.ds-metric {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-2-5) var(--space-3);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-2));
}

.label {
  overflow: hidden;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
  overflow: hidden;
  font-size: 18px;
  line-height: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unit {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.hint {
  overflow: hidden;
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ds-metric[data-tone='ok'] .value {
  color: rgb(var(--state-ok-label));
}

.ds-metric[data-tone='warn'] .value {
  color: rgb(var(--state-warn-label));
}

.ds-metric[data-tone='error'] .value {
  color: rgb(var(--state-error-label));
}

.ds-metric[data-tone='accent'] .value {
  color: rgb(var(--accent-strong));
}
</style>
