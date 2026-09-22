<script setup lang="ts">
/**
 * TokenTrendChart — the dsh token-usage trend: a legend of toggle buttons
 * (dash + point shape per series, so lines stay distinguishable without
 * color), a width:100% SVG line chart (viewBox 540×244, dashed grid, a focus
 * guide) and a hover / keyboard focus layer with a tooltip listing every
 * visible series on the focused day. ArrowLeft/Right, PageUp/Down (±7),
 * Home / End move the focus.
 *
 * Props:
 * - data: TrendData ({ dates, series: [{ id, label, sub?, values, color, dash }] }).
 * - label: chart name.
 * - format?: value formatter for the tooltip (default compact tokens).
 */
import { computed, ref, watch } from 'vue'
import { formatTokenCompact } from '../../../utils/format'
import type { TrendData, TrendSeries } from './tokenUsageModel'

const props = withDefaults(
  defineProps<{
    data: TrendData
    label: string
    format?: (value: number) => string
  }>(),
  { format: (value: number) => formatTokenCompact(value) },
)

const WIDTH = 540
const LEFT = 8
const RIGHT = 532
const TOP = 20
const BOTTOM = 224
const GRID = [0, 1, 2, 3, 4].map((index) => TOP + index * ((BOTTOM - TOP) / 4))
const POINTS = ['circle', 'square', 'diamond'] as const

const hidden = ref<ReadonlySet<string>>(new Set())
const focusIndex = ref(Math.max(0, props.data.dates.length - 1))

watch(
  () => [props.data.dates.length, props.data.dates.at(-1)],
  () => {
    focusIndex.value = Math.max(0, props.data.dates.length - 1)
  },
)
watch(
  () => props.data.series.map((series) => series.id).join('|'),
  () => {
    hidden.value = new Set()
  },
)

const visible = computed(() =>
  props.data.series.filter((series) => !hidden.value.has(series.id)),
)
const max = computed(() =>
  Math.max(1, ...visible.value.flatMap((series) => series.values)),
)
const count = computed(() => props.data.dates.length)
const focusedDate = computed(
  () => props.data.dates[focusIndex.value] ?? props.data.dates.at(-1) ?? '',
)
const focusX = computed(() => x(focusIndex.value))
const focusPct = computed(() => (focusX.value / WIDTH) * 100)
const axis = computed(() => {
  const dates = props.data.dates
  if (!dates.length) return []
  const picks =
    dates.length <= 2
      ? dates.map((_, index) => index)
      : [0, Math.floor((dates.length - 1) / 2), dates.length - 1]
  return picks.map((index) => ({
    key: index,
    label: dates[index]!.slice(5),
    pct: (x(index) / WIDTH) * 100,
  }))
})
const focusText = computed(() =>
  [
    focusedDate.value,
    ...visible.value.map(
      (series) =>
        `${series.label}: ${props.format(series.values[focusIndex.value] ?? 0)}`,
    ),
  ].join('; '),
)

function x(index: number) {
  if (count.value <= 1) return WIDTH / 2
  return LEFT + (index * (RIGHT - LEFT)) / (count.value - 1)
}

function y(value: number) {
  return TOP + (BOTTOM - TOP) * (1 - value / max.value)
}

function path(values: readonly number[]) {
  return values
    .map(
      (value, index) =>
        `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)} ${y(value).toFixed(2)}`,
    )
    .join(' ')
}

function pointOf(series: TrendSeries) {
  const index = props.data.series.findIndex((item) => item.id === series.id)
  return POINTS[Math.max(0, index) % POINTS.length]!
}

function toggle(id: string) {
  const next = new Set(hidden.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  hidden.value = next
}

function onKeydown(event: KeyboardEvent) {
  let next = focusIndex.value
  if (event.key === 'ArrowLeft') next -= 1
  else if (event.key === 'ArrowRight') next += 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = count.value - 1
  else if (event.key === 'PageUp') next -= 7
  else if (event.key === 'PageDown') next += 7
  else return
  event.preventDefault()
  focusIndex.value = Math.max(0, Math.min(count.value - 1, next))
}

function onPointerMove(event: PointerEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (rect.width <= 0 || count.value <= 1) return
  const ratio = Math.max(
    0,
    Math.min(1, (event.clientX - rect.left) / rect.width),
  )
  const px = ratio * WIDTH
  const index = Math.round(((px - LEFT) / (RIGHT - LEFT)) * (count.value - 1))
  focusIndex.value = Math.max(0, Math.min(count.value - 1, index))
}
</script>

<template>
  <div class="token-trend-chart">
    <div class="legend">
      <button
        v-for="series in data.series"
        :key="series.id"
        type="button"
        class="legend-button"
        :aria-pressed="!hidden.has(series.id)"
        :title="series.sub ? `${series.label} · ${series.sub}` : series.label"
        @click="toggle(series.id)"
      >
        <svg class="legend-glyph" viewBox="0 0 30 12" aria-hidden="true">
          <line
            x1="1"
            y1="6"
            x2="29"
            y2="6"
            :stroke="series.color"
            stroke-width="2"
            :stroke-dasharray="series.dash || undefined"
          />
          <circle
            v-if="pointOf(series) === 'circle'"
            cx="15"
            cy="6"
            r="3.5"
            :fill="series.color"
          />
          <rect
            v-else-if="pointOf(series) === 'square'"
            x="12"
            y="3"
            width="6"
            height="6"
            :fill="series.color"
          />
          <path v-else d="M15 2L19 6L15 10L11 6Z" :fill="series.color" />
        </svg>
        <span class="legend-copy">
          <span class="legend-label">{{ series.label }}</span>
          <small v-if="series.sub" class="legend-sub">{{ series.sub }}</small>
        </span>
      </button>
    </div>

    <div class="canvas">
      <svg
        class="chart"
        viewBox="0 0 540 244"
        role="img"
        :aria-label="`${label}：${focusedDate}`"
      >
        <line
          v-for="gy in GRID"
          :key="gy"
          class="grid-line"
          x1="8"
          x2="532"
          :y1="gy"
          :y2="gy"
        />
        <g v-for="series in visible" :key="series.id" :data-series="series.id">
          <path
            :d="path(series.values)"
            fill="none"
            :stroke="series.color"
            stroke-width="2"
            stroke-linejoin="round"
            :stroke-dasharray="series.dash || undefined"
            vector-effect="non-scaling-stroke"
          />
          <circle
            v-if="pointOf(series) === 'circle'"
            :cx="focusX"
            :cy="y(series.values[focusIndex] ?? 0)"
            r="3.5"
            :fill="series.color"
          />
          <rect
            v-else-if="pointOf(series) === 'square'"
            :x="focusX - 3"
            :y="y(series.values[focusIndex] ?? 0) - 3"
            width="6"
            height="6"
            :fill="series.color"
          />
          <path
            v-else
            :d="`M${focusX} ${y(series.values[focusIndex] ?? 0) - 4}l4 4l-4 4l-4 -4Z`"
            :fill="series.color"
          />
        </g>
        <line class="focus-line" :x1="focusX" :x2="focusX" y1="20" y2="224" />
      </svg>
      <div
        class="focus-layer"
        tabindex="0"
        role="slider"
        :aria-label="`${label}日期`"
        :aria-valuemin="0"
        :aria-valuemax="Math.max(0, count - 1)"
        :aria-valuenow="focusIndex"
        :aria-valuetext="focusText"
        @pointermove="onPointerMove"
        @keydown="onKeydown"
      />
      <div
        class="tooltip"
        role="tooltip"
        :data-side="focusPct > 55 ? 'left' : 'right'"
        :style="{ '--focus-x': `${focusPct}%` }"
      >
        <strong>{{ focusedDate }}</strong>
        <span v-for="series in visible" :key="series.id" class="tip-row">
          <i class="tip-swatch" :style="{ background: series.color }" />
          <span class="tip-label">{{ series.label }}</span>
          <span class="tip-value">{{
            format(series.values[focusIndex] ?? 0)
          }}</span>
        </span>
      </div>
    </div>
    <div class="axis" aria-hidden="true">
      <span
        v-for="tick in axis"
        :key="tick.key"
        class="tick"
        :style="{ left: `${tick.pct}%` }"
        >{{ tick.label }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.token-trend-chart {
  min-width: 0;
  padding: var(--space-2-5);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-2));
}

.legend {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-1);
  margin-bottom: var(--space-1-5);
}

.legend-button {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-1);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  font: inherit;
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-secondary));
  text-align: left;
  cursor: pointer;
}

.legend-button:hover {
  background: var(--interactive-bg-hover);
}

.legend-button:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.6);
}

.legend-button[aria-pressed='false'] {
  opacity: 0.42;
  text-decoration: line-through;
}

.legend-glyph {
  flex: none;
  width: 30px;
  height: 12px;
}

.legend-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.legend-label,
.legend-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legend-sub {
  font-size: var(--fs-xxxs);
  color: rgb(var(--label-tertiary));
}

.canvas {
  position: relative;
}

.chart {
  display: block;
  width: 100%;
  height: auto;
  overflow: hidden;
}

.grid-line {
  stroke: var(--border-l1);
  stroke-width: 1;
  stroke-dasharray: 2 4;
}

.focus-line {
  stroke: var(--border-l3);
  stroke-width: 1;
  pointer-events: none;
}

.focus-layer {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-xs);
  outline: none;
}

.focus-layer:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.6);
}

.tooltip {
  position: absolute;
  top: var(--space-2);
  left: var(--focus-x);
  z-index: var(--z-raised);
  display: none;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 132px;
  max-width: 240px;
  margin-left: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-sm);
  background: rgb(var(--bg-overlay));
  box-shadow: var(--shadow-lv1);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-primary));
  pointer-events: none;
}

.tooltip[data-side='left'] {
  margin-left: calc(var(--space-2) * -1);
  transform: translateX(-100%);
}

.focus-layer:hover + .tooltip,
.focus-layer:focus-visible + .tooltip {
  display: flex;
}

.tip-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.tip-swatch {
  flex: none;
  width: var(--space-1-5);
  height: var(--space-1-5);
  border-radius: var(--radius-pill);
}

.tip-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tip-value {
  font-variant-numeric: tabular-nums;
}

.axis {
  position: relative;
  height: var(--lh-xxxs);
  margin-top: var(--space-1);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
}

.tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  white-space: nowrap;
}

.tick:first-child {
  transform: none;
}

.tick:last-child:not(:first-child) {
  transform: translateX(-100%);
}

@container (max-width: 439px) {
  .legend {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
