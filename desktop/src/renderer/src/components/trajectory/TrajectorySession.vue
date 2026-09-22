<script setup lang="ts">
/**
 * TrajectorySession — TrajectoryView bound to one session (keyed by the
 * view on sessionId): wires the shared controller to the toolbar (duration
 * preference, fold all, throttled search with match stepping), the
 * timeline (brush focus, record select / focus) and the ledger.
 *
 * Props / emits: see TrajectoryView.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { ConversationStore } from '../../conversation/store'
import {
  TrajectorySearchIndex,
  trajectoryCollapsibleAssistantIds,
  trajectoryCollapsibleTurnIds,
  trajectoryDurationStore,
  trajectoryRecordId,
  trajectorySearchMatchIndexes,
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimeRange,
  type TrajectoryTimelineMode,
  type TrajectoryTurnModel,
} from '../../trajectory/model'
import TrajectoryTable from './TrajectoryTable.vue'
import TrajectoryTimeline from './TrajectoryTimeline.vue'
import TrajectoryToolbar from './TrajectoryToolbar.vue'
import InspectorPanel from './inspector/InspectorPanel.vue'
import { useTrajectory } from './useTrajectory'

const props = defineProps<{
  sessionId: string
  focusCallId: string | null
  inlineInspector: boolean
  store?: ConversationStore
}>()
const emit = defineEmits<{
  select: [recordId: string | null]
  'open-subagent': [sessionId: string]
  'inspect-applied': [callId: string]
}>()

const SEARCH_INDEX_THROTTLE_MS = 3_000

const c = useTrajectory(
  props.sessionId,
  props.store === undefined ? {} : { store: props.store },
)

// ── duration preference (app-wide, persisted) ──────────────────────────
const durations = trajectoryDurationStore()
const actualDuration = ref(durations.get())
const unsubscribeDuration = durations.subscribe((value) => {
  actualDuration.value = value
})
const mode = computed<TrajectoryTimelineMode>(() =>
  actualDuration.value ? 'duration' : 'sequence',
)
function setActualDuration(value: boolean): void {
  durations.set(value)
  timelineRange.value = null
}

// ── search (index refresh throttled while streaming) ───────────────────
const query = ref('')
const searchIndex = new TrajectorySearchIndex()
const indexRevision = ref(0)
let indexTimer: ReturnType<typeof setTimeout> | undefined
const searchLayouts = computed(
  (): readonly (readonly TrajectoryTurnModel[])[] => [
    c.finalized.value.turns,
    c.streamingTurns.value,
  ],
)
let indexed = false
watch(
  searchLayouts,
  (layouts) => {
    if (!indexed) {
      indexed = true
      if (searchIndex.update(layouts)) indexRevision.value++
      return
    }
    if (indexTimer !== undefined) return
    indexTimer = setTimeout(() => {
      indexTimer = undefined
      if (searchIndex.update(searchLayouts.value)) indexRevision.value++
    }, SEARCH_INDEX_THROTTLE_MS)
  },
  { immediate: true },
)
// A new query indexes the latest layout right away.
watch(query, () => {
  if (searchIndex.update(searchLayouts.value)) indexRevision.value++
})
const searchMatchIndexes = computed(() => {
  void indexRevision.value
  return trajectorySearchMatchIndexes(
    searchLayouts.value,
    searchIndex.search(query.value),
  )
})
const matchOrder = computed(() => {
  const matches = searchMatchIndexes.value
  if (matches === null) return []
  return c.records.value
    .filter(
      (record) =>
        record.cell.requestOnly !== true && matches.has(record.cell.index),
    )
    .map((record) => record.cell.index)
})
const matchPosition = computed(() => {
  const index = c.selectedRecord.value?.cell.index
  return index === undefined ? -1 : matchOrder.value.indexOf(index)
})
function stepMatch(direction: 1 | -1): void {
  const order = matchOrder.value
  if (order.length === 0) return
  const current = matchPosition.value
  const next =
    current < 0
      ? direction > 0
        ? 0
        : order.length - 1
      : (current + direction + order.length) % order.length
  const index = order[next]
  if (index !== undefined) c.selectRecord(index, { scroll: true })
}

// ── timeline ───────────────────────────────────────────────────────────
const timelineRange = shallowRef<TrajectoryTimeRange | null>(null)
const timelineFocusIndexes = computed(() =>
  timelineRange.value === null
    ? null
    : trajectoryTimelineFocusIndexes(
        c.turns.value,
        timelineRange.value,
        mode.value,
      ),
)
function onLedgerSelect(index: number): void {
  const focus = timelineFocusIndexes.value
  if (focus !== null && !focus.has(index)) timelineRange.value = null
}
function onTimelineSelect(index: number): void {
  timelineRange.value = null
  c.selectRecord(index, { scroll: true })
}
function onTimelineFocus(index: number): void {
  const record = c.recordByIndex(index)
  if (record !== undefined) c.requestScroll(trajectoryRecordId(record.cell))
}

// ── fold all ───────────────────────────────────────────────────────────
const collapsibleTurns = computed(() =>
  trajectoryCollapsibleTurnIds(c.turns.value),
)
const collapsibleAssistants = computed(() =>
  trajectoryCollapsibleAssistantIds(c.turns.value),
)
const allTurnsCollapsed = computed(
  () =>
    collapsibleTurns.value.length > 0 &&
    collapsibleTurns.value.every((turn) => c.collapsedTurns.value.has(turn)),
)
const allAssistantsCollapsed = computed(
  () =>
    collapsibleAssistants.value.length > 0 &&
    collapsibleAssistants.value.every((id) =>
      c.collapsedAssistants.value.has(id),
    ),
)
function toggleAllTurns(): void {
  const next = new Set(c.collapsedTurns.value)
  for (const turn of collapsibleTurns.value)
    if (allTurnsCollapsed.value) next.delete(turn)
    else next.add(turn)
  c.setCollapsedTurns(next)
}
function toggleAllAssistants(): void {
  const next = new Set(c.collapsedAssistants.value)
  for (const id of collapsibleAssistants.value)
    if (allAssistantsCollapsed.value) next.delete(id)
    else next.add(id)
  c.setCollapsedAssistants(next)
}

// ── Inspect deep link ──────────────────────────────────────────────────
let appliedCallId: string | null = null
watch(
  () => [props.focusCallId, c.turns.value] as const,
  ([callId]) => {
    if (callId === null || callId === appliedCallId) return
    if (!c.focusCall(callId)) return
    appliedCallId = callId
    emit('inspect-applied', callId)
  },
  { immediate: true },
)

watch(c.selectedRecordId, (id) => emit('select', id))

// ── inline inspector split ─────────────────────────────────────────────
const inspectorWidth = ref<number | null>(null)
const split = ref<HTMLElement | null>(null)
let resize: { pointerId: number; startX: number; startWidth: number } | null =
  null
const INSPECTOR_MIN = 320
const INSPECTOR_MAX = 720
function clampWidth(width: number): number {
  const total = split.value?.getBoundingClientRect().width ?? 1200
  return Math.round(
    Math.min(
      Math.max(width, INSPECTOR_MIN),
      Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, total - 280)),
    ),
  )
}
function onResizeDown(event: PointerEvent): void {
  if (event.button !== 0) return
  const aside = (event.currentTarget as HTMLElement).parentElement
  if (aside === null) return
  resize = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: aside.getBoundingClientRect().width,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  event.preventDefault()
}
function onResizeMove(event: PointerEvent): void {
  if (resize === null || resize.pointerId !== event.pointerId) return
  inspectorWidth.value = clampWidth(
    resize.startWidth + resize.startX - event.clientX,
  )
}
function onResizeEnd(): void {
  resize = null
}
const showInlineInspector = computed(
  () => props.inlineInspector && c.selection.value !== null,
)

onBeforeUnmount(() => {
  clearTimeout(indexTimer)
  unsubscribeDuration()
})
</script>

<template>
  <div
    class="traj-view"
    data-trajectory-view
    :data-session-id="sessionId"
    :data-running="c.running.value || undefined"
  >
    <TrajectoryToolbar
      :actual-duration="actualDuration"
      :all-turns-collapsed="allTurnsCollapsed"
      :all-assistants-collapsed="allAssistantsCollapsed"
      :query="query"
      :match-count="matchOrder.length"
      :match-position="matchPosition"
      @update:actual-duration="setActualDuration"
      @update:query="query = $event"
      @toggle-turns="toggleAllTurns"
      @toggle-calls="toggleAllAssistants"
      @step="stepMatch"
    />
    <TrajectoryTimeline
      :turns="c.turns.value"
      :mode="mode"
      :range="timelineRange"
      :selected-index="c.selectedRecord.value?.cell.index ?? null"
      :search-match-indexes="searchMatchIndexes"
      :running="c.running.value"
      :has-earlier-records="c.windowState.value.hasMore"
      @range-change="timelineRange = $event"
      @record-select="onTimelineSelect"
      @record-focus="onTimelineFocus"
      @load-earlier="c.loadOlder()"
    />
    <div ref="split" class="split">
      <TrajectoryTable
        :controller="c"
        :search-matches="searchMatchIndexes"
        :timeline-focus-indexes="timelineFocusIndexes"
        @record-select="onLedgerSelect"
        @clear="timelineRange = null"
      />
      <div
        v-if="showInlineInspector"
        class="inline-inspector"
        :style="
          inspectorWidth === null ? undefined : { width: `${inspectorWidth}px` }
        "
      >
        <div
          class="resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize event details"
          title="Drag to resize. Double-click to reset."
          @pointerdown="onResizeDown"
          @pointermove="onResizeMove"
          @pointerup="onResizeEnd"
          @pointercancel="onResizeEnd"
          @dblclick="inspectorWidth = null"
        />
        <InspectorPanel
          :controller="c"
          @open-subagent="emit('open-subagent', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.traj-view {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: rgb(var(--label-primary));
  background: rgb(var(--bg-layer-1));
}

.split {
  position: relative;
  isolation: isolate;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.inline-inspector {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: clamp(320px, 38%, 440px);
  max-width: calc(100% - 280px);
  min-height: 0;
  border-left: 1px solid var(--border-l2);
}

.resize-handle {
  position: absolute;
  z-index: var(--z-raised);
  top: 0;
  bottom: 0;
  left: calc(-1 * var(--space-1));
  width: 8px;
  cursor: col-resize;
  touch-action: none;
}

@media (max-width: 760px) {
  .inline-inspector {
    position: absolute;
    z-index: var(--z-overlay);
    top: 0;
    right: 0;
    bottom: 0;
    width: min(92%, 420px);
    max-width: 92%;
    box-shadow: var(--shadow-lv3);
  }
}
</style>
