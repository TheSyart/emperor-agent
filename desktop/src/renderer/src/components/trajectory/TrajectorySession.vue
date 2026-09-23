<script setup lang="ts">
/**
 * TrajectorySession — TrajectoryView bound to one session (keyed by the
 * view on sessionId): wires the shared controller to the toolbar (duration
 * preference, fold all, throttled search with match stepping, inspector
 * toggle), the timeline (brush focus, record select / focus), the ledger
 * and the inspector column — the app's only inspector. The column shows
 * while `frame.inspectorOpen`; selecting a record opens it, collapsing it
 * keeps the selection. Its width is dragged through useResizable and
 * persisted in frameState. Below a 640px split (container query) it
 * overlays the ledger instead.
 *
 * Props / emits: see TrajectoryView.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useResizable } from '../../composables/useResizable'
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
import { focusCallStep } from './focusCallRetry'
import { useTrajectory } from './useTrajectory'
import {
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
} from '../shell/columns'
import { frameActions, useFrameState } from '../shell/frameState'

const props = defineProps<{
  sessionId: string
  focusCallId: string | null
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

// ── inspector column ───────────────────────────────────────────────────
const frame = useFrameState()
const inspectorOpen = computed(() => frame.inspectorOpen)
// Selecting (another) record or request brings the column back (registered
// before the deep-link watcher so its immediate selection opens it too).
watch(c.selection, (selection) => {
  if (selection !== null) frameActions.openInspector(frame)
})
const inspectorWidth = computed({
  get: () => frame.inspectorWidth,
  set: (px: number) => frameActions.setInspectorWidth(frame, px),
})
const resizer = useResizable({
  size: inspectorWidth,
  min: INSPECTOR_MIN,
  max: INSPECTOR_MAX,
  edge: 'left',
})
function toggleInspector(): void {
  frameActions.toggleInspector(frame)
}
function collapseInspector(): void {
  frameActions.closeInspector(frame)
}
function resetInspectorWidth(): void {
  frameActions.setInspectorWidth(frame, INSPECTOR_DEFAULT)
}

// ── Inspect deep link ──────────────────────────────────────────────────
// A call outside the loaded window pages older history in (bounded) and
// retries as the turns grow.
let appliedCallId: string | null = null
let huntedCallId: string | null = null
let olderPagesLoaded = 0
watch(
  () => [props.focusCallId, c.turns.value, c.windowState.value] as const,
  ([callId, , sessionWindow]) => {
    if (callId === null || callId === appliedCallId) return
    if (callId !== huntedCallId) {
      huntedCallId = callId
      olderPagesLoaded = 0
    }
    if (c.focusCall(callId)) {
      appliedCallId = callId
      emit('inspect-applied', callId)
      return
    }
    if (focusCallStep(sessionWindow, olderPagesLoaded) !== 'load-older') return
    olderPagesLoaded++
    void c.loadOlder()
  },
  { immediate: true },
)

watch(c.selectedRecordId, (id) => emit('select', id))

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
      :inspector-open="inspectorOpen"
      @update:actual-duration="setActualDuration"
      @update:query="query = $event"
      @toggle-turns="toggleAllTurns"
      @toggle-calls="toggleAllAssistants"
      @step="stepMatch"
      @toggle-inspector="toggleInspector"
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
    <div class="split">
      <TrajectoryTable
        :controller="c"
        :search-matches="searchMatchIndexes"
        :timeline-focus-indexes="timelineFocusIndexes"
        @record-select="onLedgerSelect"
        @clear="timelineRange = null"
      />
      <div
        v-if="inspectorOpen"
        class="inspector-col"
        :data-resizing="resizer.resizing.value || undefined"
        :style="{ '--inspector-width': `${inspectorWidth}px` }"
      >
        <div
          class="resize-handle"
          v-bind="resizer.separatorProps"
          aria-label="调整详情宽度"
          title="拖动调整宽度，双击恢复默认"
          @dblclick="resetInspectorWidth"
        />
        <InspectorPanel
          :controller="c"
          @open-subagent="emit('open-subagent', $event)"
          @collapse="collapseInspector"
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
  container: trajectory-split / inline-size;
  position: relative;
  isolation: isolate;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* The ledger keeps at least 280px beside the column. */
.inspector-col {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: var(--inspector-width);
  max-width: calc(100% - 280px);
  min-height: 0;
  border-left: 1px solid var(--border-l2);
  background: rgb(var(--bg-layer-1));
}

.resize-handle {
  position: absolute;
  z-index: var(--z-raised);
  top: 0;
  bottom: 0;
  left: calc(-1 * var(--space-1));
  width: var(--space-2);
  cursor: col-resize;
  touch-action: none;
  outline: none;
}

.resize-handle:hover,
.resize-handle:focus-visible,
.inspector-col[data-resizing] .resize-handle {
  background: linear-gradient(
    90deg,
    transparent calc(50% - 1px),
    rgb(var(--focus-ring) / 0.5) calc(50% - 1px),
    rgb(var(--focus-ring) / 0.5) calc(50% + 1px),
    transparent calc(50% + 1px)
  );
}

/* Narrow split: the column floats over the ledger. */
@container trajectory-split (max-width: 639px) {
  .inspector-col {
    position: absolute;
    z-index: var(--z-overlay);
    top: 0;
    right: 0;
    bottom: 0;
    width: min(92%, var(--inspector-width));
    max-width: 92%;
    box-shadow: var(--shadow-lv3);
  }
}
</style>
