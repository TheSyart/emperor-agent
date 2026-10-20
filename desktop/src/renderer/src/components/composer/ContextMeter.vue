<script setup lang="ts">
/**
 * ContextMeter — dsh 28px context ring; click opens a ui/Popover (264px,
 * above the ring) with used / max tokens, percent and a usage bar. Data
 * comes from the runtime's context_usage projection (boot.context_used and
 * the current model's context window).
 */
import { computed, ref } from 'vue'
import Popover from '../ui/Popover.vue'

const props = defineProps<{ used: number; max: number }>()

const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)

const ratio = computed(() =>
  props.max > 0 ? Math.min(1, Math.max(0, props.used / props.max)) : 0,
)
const percent = computed(() => Math.round(ratio.value * 100))
const radius = 10
const circumference = 2 * Math.PI * radius
const dash = computed(() => `${circumference * ratio.value} ${circumference}`)
const tone = computed(() =>
  ratio.value >= 0.9 ? 'danger' : ratio.value >= 0.75 ? 'warn' : 'normal',
)
const label = computed(
  () => `上下文 ${fmt(props.used)} / ${fmt(props.max)}，已用 ${percent.value}%`,
)

function fmt(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}
</script>

<template>
  <span class="context-meter">
    <button
      ref="trigger"
      type="button"
      class="trigger"
      :aria-label="label"
      :title="open ? undefined : label"
      :aria-expanded="open"
      :data-tone="tone"
      @click="open = !open"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <circle class="track" cx="12" cy="12" :r="radius" />
        <circle
          class="fill"
          cx="12"
          cy="12"
          :r="radius"
          :stroke-dasharray="dash"
          transform="rotate(-90 12 12)"
        />
      </svg>
    </button>
    <Popover
      v-model:open="open"
      :anchor="trigger"
      label="上下文用量"
      :width="264"
      placement="top"
    >
      <div class="usage">
        <div class="header">
          <span class="headline">上下文窗口</span>
          <span class="figures">{{ fmt(used) }} / {{ fmt(max) }}</span>
        </div>
        <div class="bar">
          <span
            class="segment"
            :data-tone="tone"
            :style="{ width: `${percent}%` }"
          />
        </div>
        <dl class="rows">
          <div class="row">
            <dt>已用</dt>
            <dd>{{ percent }}%</dd>
          </div>
          <div class="row">
            <dt>剩余</dt>
            <dd>{{ fmt(Math.max(0, max - used)) }}</dd>
          </div>
        </dl>
      </div>
    </Popover>
  </span>
</template>

<style scoped>
.context-meter {
  position: relative;
  display: inline-flex;
}

.trigger {
  display: grid;
  place-items: center;
  flex: none;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--text-3));
  cursor: pointer;
}

.trigger:hover,
.trigger[aria-expanded='true'] {
  background: var(--surface-hover);
}

.trigger[data-tone='warn'] {
  color: rgb(var(--approval-line));
}

.trigger[data-tone='danger'] {
  color: rgb(var(--error));
}

.track {
  fill: none;
  stroke: var(--stroke-4);
  stroke-width: 2;
}

.fill {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}

.usage {
  font-size: var(--fs-xxs);
  line-height: var(--space-5);
  color: rgb(var(--text-2));
  cursor: default;
}

.header {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
}

.headline {
  color: rgb(var(--text-3));
}

.figures {
  margin-left: auto;
  font-weight: var(--weight-medium);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-1));
}

.bar {
  display: flex;
  height: var(--space-1);
  margin: var(--space-2-5) 0 var(--space-3);
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
}

.segment {
  min-width: 2px;
  height: 100%;
  border-radius: 0;
  background: rgb(var(--text-3));
}

.segment[data-tone='warn'] {
  background: rgb(var(--approval-line));
}

.segment[data-tone='danger'] {
  background: rgb(var(--error));
}

.rows {
  margin: 0;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-0-5) 0;
}

.row dt {
  color: rgb(var(--text-2));
}

.row dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-1));
}
</style>
