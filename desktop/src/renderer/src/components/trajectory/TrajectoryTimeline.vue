<script setup lang="ts">
/**
 * TrajectoryTimeline — dsh Chrome-Network-style overview above the ledger:
 * three lanes (Input / Model / Tools) of record spans (assistant spans split
 * into TTFT and decoding), turn boundaries, a time axis and a running
 * playhead. Drag to brush a range (focuses the ledger), click a span to
 * select it, click whitespace to focus the nearest record, wheel to zoom,
 * right-drag to pan a zoomed view, right-click / double-click / Escape to
 * clear the range; hovering a span for 500 ms shows its timing.
 *
 * Props: turns; mode; range; selectedIndex?; searchMatchIndexes?;
 * running?; hasEarlierRecords?.
 * Emits: range-change(range | null), record-select(index),
 * record-focus(index), load-earlier.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  TIMELINE_MINIMUM_DRAG_PX,
  clampFraction,
  commitTimelineBrush,
  deriveTrajectoryTimeline,
  edgePanTimelineStart,
  nearestTimelineSpan,
  orderedRange,
  panTimelineViewport,
  rangeFraction,
  retainTimelineRange,
  revealTimelineSpan,
  timelineDomain,
  timelineRecordDetail,
  timelineTooltipLabel,
  timelineTtftFraction,
  visibleTimelineSpans,
  zoomTimelineViewport,
  type TrajectoryTimeRange,
  type TrajectoryTimelineMode,
  type TrajectoryTurnModel,
} from '../../trajectory/model'
import { formatDurationMs } from './trajectoryFormat'

const props = withDefaults(
  defineProps<{
    turns: readonly TrajectoryTurnModel[]
    mode: TrajectoryTimelineMode
    range: TrajectoryTimeRange | null
    selectedIndex?: number | null
    searchMatchIndexes?: ReadonlySet<number> | null
    running?: boolean
    hasEarlierRecords?: boolean
  }>(),
  {
    selectedIndex: null,
    searchMatchIndexes: null,
    running: false,
    hasEarlierRecords: false,
  },
)
const emit = defineEmits<{
  'range-change': [range: TrajectoryTimeRange | null]
  'record-select': [index: number]
  'record-focus': [index: number]
  'load-earlier': []
}>()

const TOOLTIP_DELAY_MS = 500
const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1]

const model = computed(() => deriveTrajectoryTimeline(props.turns, props.mode))
const details = computed(
  () =>
    new Map(
      props.turns.flatMap((turn) =>
        turn.groups.flatMap((group) =>
          group.cells.map(
            (cell) => [cell.index, timelineRecordDetail(cell)] as const,
          ),
        ),
      ),
    ),
)

const root = ref<HTMLElement | null>(null)
const track = ref<HTMLElement | null>(null)
const viewport = ref<TrajectoryTimeRange | null>(null)
const draft = ref<TrajectoryTimeRange | null>(null)
const hover = ref<{ fraction: number; recordIndex: number | null } | null>(null)
const panning = ref(false)
const animate = ref(false)
const tooltip = ref<{ text: string; left: number; top: number } | null>(null)
let tooltipTimer: ReturnType<typeof setTimeout> | undefined
let drag: {
  pointerId: number
  anchorTime: number
  anchorX: number
  recordIndex: number | null
} | null = null
let pan: {
  pointerId: number
  anchorX: number
  anchorStart: number
  moved: boolean
  pannable: boolean
} | null = null

const domain = computed(() =>
  model.value === null ? null : timelineDomain(model.value, viewport.value),
)

// Drop a range / viewport that no longer overlaps a changed model.
watch(model, (next) => {
  if (next === null) return
  animate.value = false
  viewport.value = retainTimelineRange(next, viewport.value)
  if (props.range !== null && retainTimelineRange(next, props.range) === null)
    emit('range-change', null)
})

// Keep the selected record visible in a zoomed viewport.
watch(
  () => props.selectedIndex,
  (index) => {
    const current = model.value
    if (current === null || index === null) return
    const span = current.spans.find((candidate) => candidate.index === index)
    if (span === undefined) return
    animate.value = true
    viewport.value = revealTimelineSpan(current, viewport.value, span)
  },
)

const domainStyle = computed(() => {
  const current = model.value
  const view = domain.value
  if (current === null || view === null) return {}
  return {
    '--traj-domain-left': `${(-(view.start - current.start) / view.duration) * 100}%`,
    '--traj-domain-width': `${(view.fullDuration / view.duration) * 100}%`,
  }
})

function fractionRange(range: TrajectoryTimeRange | null) {
  const current = model.value
  const view = domain.value
  if (range === null || current === null || view === null) return null
  return rangeFraction(
    range,
    view.start,
    view.duration,
    current.start,
    current.end,
  )
}
const visibleRange = computed(
  () => fractionRange(draft.value) ?? fractionRange(props.range),
)
const activeRange = computed(() => draft.value ?? props.range)

const spans = computed(() => {
  const current = model.value
  const view = domain.value
  if (current === null || view === null) return []
  const full = view.fullDuration
  return visibleTimelineSpans(current, view, props.selectedIndex).map(
    (span) => {
      const left = (span.start - current.start) / full
      const width = ((span.end - span.start) / full) * 100
      const ttft = timelineTtftFraction(details.value.get(span.index))
      const range = activeRange.value
      return {
        span,
        style: {
          '--traj-span-left': `${left * 100}%`,
          '--traj-span-width': `${width}%`,
          '--traj-span-gap': `min(${width * 0.08}%, 1px)`,
          '--traj-span-lane': String(span.lane),
          ...(ttft === null ? {} : { '--traj-span-ttft': `${ttft * 100}%` }),
        },
        ttft: ttft !== null,
        selected:
          range === null
            ? undefined
            : span.start <= range.end && span.end >= range.start
              ? 'true'
              : 'false',
        search:
          props.searchMatchIndexes === null
            ? undefined
            : props.searchMatchIndexes.has(span.index)
              ? 'true'
              : 'false',
      }
    },
  )
})

const boundaries = computed(() => {
  const current = model.value
  const view = domain.value
  if (current === null || view === null) return []
  return current.turnBoundaries
    .filter(
      (boundary) =>
        boundary.time > current.start &&
        boundary.time >= view.start &&
        boundary.time <= view.start + view.duration,
    )
    .map((boundary) => ({
      turn: boundary.turn,
      left: `${((boundary.time - current.start) / view.fullDuration) * 100}%`,
    }))
})

const axis = computed(() => {
  const current = model.value
  const view = domain.value
  if (current === null || view === null) return []
  return AXIS_TICKS.map((fraction) => {
    const value = view.start + fraction * view.duration - current.start
    return {
      fraction,
      label:
        props.mode === 'sequence'
          ? `#${Math.round(value)}`
          : formatDurationMs(Math.max(0, value)),
    }
  })
})

const playhead = computed(() => {
  const current = model.value
  const view = domain.value
  if (!props.running || current === null || view === null) return null
  const fraction = (current.end - view.start) / view.duration
  return fraction < 0 || fraction > 1.001 ? null : `${fraction * 100}%`
})

const showEarlier = computed(
  () =>
    props.hasEarlierRecords &&
    (model.value === null || domain.value?.start === model.value.start),
)

function fractionAt(event: PointerEvent | WheelEvent): number {
  const rect = track.value?.getBoundingClientRect()
  if (rect === undefined) return 0
  return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width))
}

function recordIndexAt(event: Event): number | null {
  const target = event.target instanceof Element ? event.target : null
  const value = target
    ?.closest<HTMLElement>('[data-timeline-record-index]')
    ?.getAttribute('data-timeline-record-index')
  if (value === null || value === undefined) return null
  const index = Number(value)
  return Number.isFinite(index) ? index : null
}

function hideTooltip(): void {
  clearTimeout(tooltipTimer)
  tooltip.value = null
}

function scheduleTooltip(event: PointerEvent, recordIndex: number | null) {
  if (recordIndex === null || drag !== null || pan !== null) {
    hideTooltip()
    return
  }
  if (hover.value?.recordIndex === recordIndex && tooltip.value !== null) return
  hideTooltip()
  const span = model.value?.spans.find(
    (candidate) => candidate.index === recordIndex,
  )
  if (span === undefined) return
  const { clientX, clientY } = event
  tooltipTimer = setTimeout(() => {
    tooltip.value = {
      text: timelineTooltipLabel(span.kind, details.value.get(span.index)),
      left: clientX,
      top: clientY + 14,
    }
  }, TOOLTIP_DELAY_MS)
}

function onPointerDown(event: PointerEvent): void {
  const current = model.value
  const view = domain.value
  if (current === null || view === null) return
  hideTooltip()
  const target = event.currentTarget as HTMLElement
  if (event.button === 2) {
    pan = {
      pointerId: event.pointerId,
      anchorX: event.clientX,
      anchorStart: view.start,
      moved: false,
      pannable: viewport.value !== null,
    }
    if (viewport.value !== null) animate.value = false
    panning.value = true
    target.setPointerCapture?.(event.pointerId)
    return
  }
  if (event.button !== 0) return
  const fraction = fractionAt(event)
  const anchorTime = view.start + fraction * view.duration
  const recordIndex = recordIndexAt(event)
  hover.value = { fraction, recordIndex }
  drag = {
    pointerId: event.pointerId,
    anchorTime,
    anchorX: event.clientX,
    recordIndex,
  }
  target.setPointerCapture?.(event.pointerId)
  draft.value = { start: anchorTime, end: anchorTime }
}

function onPointerMove(event: PointerEvent): void {
  const current = model.value
  const view = domain.value
  if (current === null || view === null) return
  const fraction = fractionAt(event)
  const recordIndex = recordIndexAt(event)
  scheduleTooltip(event, recordIndex)
  hover.value = { fraction, recordIndex }
  if (pan !== null && pan.pointerId === event.pointerId) {
    if (Math.abs(event.clientX - pan.anchorX) >= TIMELINE_MINIMUM_DRAG_PX)
      pan.moved = true
    if (!pan.pannable) return
    const width = track.value?.getBoundingClientRect().width ?? 1
    viewport.value = panTimelineViewport(
      current,
      pan.anchorStart,
      view.duration,
      (event.clientX - pan.anchorX) / Math.max(1, width),
    )
    return
  }
  if (drag === null || drag.pointerId !== event.pointerId) return
  const rect = track.value?.getBoundingClientRect()
  let start = view.start
  if (rect !== undefined) {
    start = edgePanTimelineStart(
      current,
      view,
      event.clientX - rect.left,
      rect.width,
    )
    if (start !== view.start) {
      animate.value = false
      viewport.value = { start, end: start + view.duration }
    }
  }
  draft.value = orderedRange(drag.anchorTime, start + fraction * view.duration)
}

function onPointerUp(event: PointerEvent): void {
  const current = model.value
  const view = domain.value
  if (pan !== null && pan.pointerId === event.pointerId) {
    const moved =
      pan.moved ||
      Math.abs(event.clientX - pan.anchorX) >= TIMELINE_MINIMUM_DRAG_PX
    pan = null
    panning.value = false
    if (!moved) emit('range-change', null)
    return
  }
  if (drag === null || drag.pointerId !== event.pointerId) return
  const gesture = drag
  drag = null
  draft.value = null
  if (current === null || view === null) return
  const pointTime = view.start + fractionAt(event) * view.duration
  const click =
    Math.abs(event.clientX - gesture.anchorX) < TIMELINE_MINIMUM_DRAG_PX
  if (click && gesture.recordIndex !== null) {
    emit('range-change', null)
    emit('record-select', gesture.recordIndex)
    return
  }
  const committed = commitTimelineBrush(
    current,
    view,
    gesture.anchorTime,
    pointTime,
    click,
  )
  emit('range-change', committed)
  if (click) {
    const nearest = nearestTimelineSpan(
      current,
      orderedRange(gesture.anchorTime, pointTime).start,
    )
    if (nearest !== undefined) emit('record-focus', nearest.index)
  }
}

function onPointerCancel(): void {
  drag = null
  pan = null
  draft.value = null
  hover.value = null
  panning.value = false
  hideTooltip()
}

function onPointerLeave(): void {
  if (drag === null && pan === null) hover.value = null
  hideTooltip()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || props.range === null) return
  event.preventDefault()
  emit('range-change', null)
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const current = model.value
  const view = domain.value
  if (current === null || view === null) return
  animate.value = false
  hideTooltip()
  viewport.value = zoomTimelineViewport(
    current,
    view,
    fractionAt(event),
    event.deltaY,
    props.mode,
  )
}

onMounted(() => {
  root.value?.addEventListener('wheel', onWheel, { passive: false })
})
onBeforeUnmount(() => {
  root.value?.removeEventListener('wheel', onWheel)
  clearTimeout(tooltipTimer)
})
</script>

<template>
  <section ref="root" class="traj-timeline" aria-label="Trajectory timeline">
    <div class="plot">
      <div class="labels" aria-hidden="true">
        <span>Input</span>
        <span>Model</span>
        <span>Tools</span>
      </div>
      <div
        ref="track"
        class="track"
        tabindex="0"
        aria-label="Timeline overview; drag horizontally to focus events"
        :data-panning="panning || undefined"
        :data-zoomed="viewport !== null || undefined"
        @keydown="onKeydown"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @pointerleave="onPointerLeave"
        @dblclick.prevent="emit('range-change', null)"
        @contextmenu.prevent
      >
        <span v-if="model === null" class="empty">No timing data</span>
        <button
          v-if="showEarlier"
          type="button"
          class="earlier"
          aria-label="Load earlier history"
          title="Click to load earlier history"
          @pointerdown.stop
          @click="emit('load-earlier')"
        >
          …
        </button>
        <div
          v-if="hover !== null && hover.recordIndex === null && draft === null"
          class="hover-line"
          aria-hidden="true"
          :style="{ '--traj-hover-left': `${hover.fraction * 100}%` }"
        />
        <template v-if="visibleRange !== null">
          <div
            class="selection"
            data-timeline-selection
            :data-dragging="draft !== null || undefined"
            aria-hidden="true"
            :style="{
              '--traj-selection-left': `${visibleRange.start * 100}%`,
              '--traj-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`,
            }"
          />
          <div
            class="selection-edges"
            :data-dragging="draft !== null || undefined"
            aria-hidden="true"
            :style="{
              '--traj-selection-left': `${visibleRange.start * 100}%`,
              '--traj-selection-width': `${(visibleRange.end - visibleRange.start) * 100}%`,
            }"
          />
        </template>
        <div
          class="boundaries"
          :data-animate="animate || undefined"
          aria-hidden="true"
          :style="domainStyle"
        >
          <span
            v-for="boundary in boundaries"
            :key="boundary.turn"
            class="boundary"
            :data-turn="boundary.turn"
            :style="{ '--traj-turn-left': boundary.left }"
          />
        </div>
        <div
          class="lanes"
          :data-animate="animate || undefined"
          data-timeline-domain
          :style="domainStyle"
        >
          <span
            v-for="item in spans"
            :key="item.span.index"
            aria-hidden="true"
            class="span"
            :data-timeline-span="item.span.kind"
            :data-timeline-record-index="item.span.index"
            :data-assistant-timing="item.ttft || undefined"
            :data-error="item.span.isError || undefined"
            :data-current="item.span.index === selectedIndex || undefined"
            :data-hovered="hover?.recordIndex === item.span.index || undefined"
            :data-selected="item.selected"
            :data-search-match="item.search"
            :style="item.style"
          />
        </div>
        <div
          v-if="playhead !== null"
          class="playhead"
          data-timeline-playhead
          aria-hidden="true"
          :style="{ '--traj-playhead-left': playhead }"
        />
        <div v-if="model !== null" class="axis" aria-hidden="true">
          <span
            v-for="tick in axis"
            :key="tick.fraction"
            class="tick"
            :data-edge="
              tick.fraction === 0
                ? 'start'
                : tick.fraction === 1
                  ? 'end'
                  : undefined
            "
            :style="{ '--traj-tick-left': `${tick.fraction * 100}%` }"
            >{{ tick.label }}</span
          >
        </div>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="tooltip !== null"
        class="traj-timeline-tooltip ds-fade-in"
        role="tooltip"
        :style="{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }"
      >
        {{ tooltip.text }}
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.traj-timeline {
  position: relative;
  isolation: isolate;
  flex: none;
  border-bottom: 1px solid var(--border-l2);
  user-select: none;
}

.plot {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  height: 62px;
  overflow: hidden;
  background: rgb(var(--bg-layer-2));
}

.labels {
  position: relative;
  border-right: 1px solid var(--border-l1);
  color: rgb(var(--label-caption));
  font: 10px / 1 var(--font-sans);
}

.labels span {
  position: absolute;
  right: calc(var(--space-1) - 1px);
  display: flex;
  align-items: center;
  height: 8px;
}

.labels span:nth-child(1) {
  top: calc(var(--space-2) - 1px);
}

.labels span:nth-child(2) {
  top: calc(var(--space-5) + 1px);
}

.labels span:nth-child(3) {
  top: calc(var(--space-8) + 3px);
}

.track {
  position: relative;
  overflow: hidden;
  cursor: crosshair;
  touch-action: none;
  outline: none;
}

.track:focus-visible {
  box-shadow: inset 0 0 0 1px rgb(var(--focus-ring));
}

.track[data-panning='true'] {
  cursor: grabbing;
}

.empty {
  position: absolute;
  top: 50%;
  left: 50%;
  color: rgb(var(--label-caption));
  font: var(--font-xs);
  transform: translate(-50%, -50%);
}

.earlier {
  position: absolute;
  z-index: var(--z-overlay);
  top: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  width: 28px;
  padding: 0 0 0 calc(var(--space-1) - 1px);
  border: 0;
  background: linear-gradient(
    to right,
    rgb(var(--bg-layer-2)) 0,
    rgb(var(--bg-layer-2)) 38%,
    transparent 100%
  );
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  opacity: 0.72;
  cursor: pointer;
}

.earlier:hover {
  opacity: 1;
}

.lanes,
.boundaries {
  position: absolute;
  left: var(--traj-domain-left, 0%);
  width: var(--traj-domain-width, 100%);
}

.lanes {
  z-index: var(--z-raised);
  top: calc(var(--space-2) - 1px);
  bottom: calc(var(--space-4) + 3px);
}

.boundaries {
  z-index: var(--z-sticky);
  top: 0;
  bottom: var(--space-3);
  pointer-events: none;
}

.lanes[data-animate='true'],
.boundaries[data-animate='true'] {
  transition: transform var(--duration-ds) var(--ease-out);
}

.boundary {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--traj-turn-left);
  width: 1px;
  background: var(--border-l2);
}

.span {
  position: absolute;
  top: calc(var(--traj-span-lane) * 14px);
  left: calc(var(--traj-span-left) + var(--traj-span-gap));
  width: max(
    2px,
    calc(var(--traj-span-width) - var(--traj-span-gap) - var(--traj-span-gap))
  );
  height: 8px;
  min-width: 2px;
  border-radius: 2px;
  background: rgb(var(--label-secondary));
  opacity: 0.78;
}

.span[data-timeline-span='user'] {
  background: rgb(var(--accent-fill));
}

.span[data-timeline-span='context'] {
  background: color-mix(
    in srgb,
    rgb(var(--ok)) 68%,
    rgb(var(--label-secondary))
  );
}

.span[data-timeline-span='message'] {
  --traj-decoding: rgb(var(--tone-violet));
  --traj-ttft: color-mix(
    in srgb,
    rgb(var(--tone-violet)) 54%,
    rgb(var(--bg-layer-2))
  );

  background: var(--traj-decoding);
  opacity: 1;
}

.span[data-timeline-span='message'][data-assistant-timing='true'] {
  background: linear-gradient(
    to right,
    var(--traj-ttft) 0,
    var(--traj-ttft) var(--traj-span-ttft),
    var(--traj-decoding) var(--traj-span-ttft),
    var(--traj-decoding) 100%
  );
}

.span[data-timeline-span='tool'],
.span[data-timeline-span='subtool'] {
  background: rgb(var(--approval-strong));
  opacity: 1;
}

.span[data-error='true'] {
  background: rgb(var(--danger));
}

.span[data-selected='false'] {
  opacity: 0.2;
}

.span[data-hovered='true']:not([data-current='true']) {
  z-index: var(--z-raised);
  opacity: 1;
  box-shadow:
    0 0 0 1px rgb(var(--bg-layer-2)),
    0 0 0 2px color-mix(in srgb, rgb(var(--accent-fill)) 80%, transparent);
}

.span[data-current='true'] {
  z-index: var(--z-raised);
  opacity: 1;
  box-shadow:
    0 0 0 1px rgb(var(--bg-layer-2)),
    0 0 0 2px rgb(var(--accent-fill));
}

.span[data-search-match='false'] {
  opacity: 0.14;
}

.selection,
.selection-edges {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--traj-selection-left);
  width: var(--traj-selection-width);
  min-width: 1px;
  pointer-events: none;
}

.selection {
  z-index: var(--z-base);
  background: color-mix(in srgb, rgb(var(--accent-fill)) 12%, transparent);
  box-shadow:
    -100vw 0 0 100vw color-mix(in srgb, rgb(var(--bg-layer-1)) 58%, transparent),
    100vw 0 0 100vw color-mix(in srgb, rgb(var(--bg-layer-1)) 58%, transparent);
}

.selection[data-dragging='true'] {
  background: color-mix(in srgb, rgb(var(--accent-fill)) 18%, transparent);
}

.selection-edges {
  z-index: var(--z-overlay);
}

.selection-edges::before,
.selection-edges::after {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 3px;
  background: rgb(var(--accent-fill));
  content: '';
}

.selection-edges::before {
  left: 0;
}

.selection-edges::after {
  right: 0;
}

.selection-edges[data-dragging='true']::before,
.selection-edges[data-dragging='true']::after {
  width: 2px;
}

.hover-line {
  position: absolute;
  z-index: var(--z-overlay);
  top: 0;
  bottom: 0;
  left: clamp(0px, calc(var(--traj-hover-left) - 1px), calc(100% - 2px));
  width: 2px;
  background: rgb(var(--accent-fill));
  pointer-events: none;
}

.playhead {
  position: absolute;
  z-index: var(--z-overlay);
  top: 0;
  bottom: var(--space-3);
  left: clamp(0px, calc(var(--traj-playhead-left) - 1px), calc(100% - 2px));
  width: 2px;
  background: rgb(var(--accent-fill));
  box-shadow: 0 0 0 2px
    color-mix(in srgb, rgb(var(--accent-fill)) 24%, transparent);
  pointer-events: none;
  animation: traj-playhead 1.2s var(--ease-in-out) infinite;
}

@keyframes traj-playhead {
  50% {
    opacity: 0.35;
  }
}

.axis {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 12px;
  border-top: 1px solid var(--border-l1);
  pointer-events: none;
}

.tick {
  position: absolute;
  bottom: 0;
  left: var(--traj-tick-left);
  color: rgb(var(--label-caption));
  font: 9px / 11px var(--font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  transform: translateX(-50%);
}

.tick[data-edge='start'] {
  padding-left: 2px;
  transform: none;
}

.tick[data-edge='end'] {
  padding-right: 2px;
  transform: translateX(-100%);
}

.traj-timeline-tooltip {
  position: fixed;
  z-index: var(--z-lightbox);
  max-width: 50vw;
  padding: calc(var(--space-1) - 1px) calc(var(--space-2) - 1px);
  border-radius: var(--radius-row);
  background: rgb(var(--tooltip-bg));
  color: rgb(var(--tooltip-fg));
  font: var(--font-xxxs);
  white-space: pre-line;
  pointer-events: none;
  transform: translateX(-50%);
}
</style>
