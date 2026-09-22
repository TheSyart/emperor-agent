<script setup lang="ts">
/**
 * TrajectoryTable — the dsh turn-aware event ledger. Rows come from the
 * shared controller (useTrajectory) folded / filtered by `ledgerRows.ts`;
 * fixed row heights (30 / 20 / 9) feed a RecycleScroller (page mode inside
 * the ledger pane) once the ledger exceeds `virtualizeThreshold` rows or
 * older history remains. Opens at the tail and follows it until the reader
 * scrolls up; reaching the top loads one older page with the scroll anchor
 * preserved. Keyboard: see tableKeyboard.ts.
 *
 * Props: controller; searchMatches; timelineFocusIndexes;
 * virtualizeThreshold? (default 100).
 * Emits: record-select(index) (direct row selection), clear (whitespace
 * click: clears selection and the timeline range).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
// @ts-expect-error vue-virtual-scroller v2 beta 无类型声明（见 shims）
import { RecycleScroller } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import {
  indexTrajectoryRequestBoundaryRuns,
  trajectoryAssistantToolCalls,
  trajectoryRecordId,
  trajectoryRequestKey,
  type TrajectoryLedgerRecord,
  type TrajectoryRequestNumber,
} from '../../trajectory/model'
import TrajectoryCell from './TrajectoryCell.vue'
import TrajectoryGroupHeader from './TrajectoryGroupHeader.vue'
import TrajectoryTurnHeader from './TrajectoryTurnHeader.vue'
import {
  deriveLedgerDisplay,
  layoutLedgerRows,
  requestMarkerOf,
  rowAtOffset,
  turnTotals,
  type LedgerRow,
  type RequestMarker,
} from './ledgerRows'
import { ledgerKeyAction, turnCollapsible } from './tableKeyboard'
import type { TrajectoryController } from './useTrajectory'

const props = withDefaults(
  defineProps<{
    controller: TrajectoryController
    searchMatches?: ReadonlySet<number> | null
    timelineFocusIndexes?: ReadonlySet<number> | null
    virtualizeThreshold?: number
  }>(),
  {
    searchMatches: null,
    timelineFocusIndexes: null,
    virtualizeThreshold: 100,
  },
)
const emit = defineEmits<{
  'record-select': [index: number]
  clear: []
}>()

const BOTTOM_FOLLOW_THRESHOLD_PX = 2
const OLDER_LOAD_THRESHOLD_PX = 48
const HEADER_HEIGHT = 28
const HISTORY_ROW_HEIGHT = 30

const c = props.controller
const pane = ref<HTMLElement | null>(null)

// ── display rows ───────────────────────────────────────────────────────
const display = computed(() =>
  deriveLedgerDisplay(c.records.value, {
    collapsedTurns: c.collapsedTurns.value,
    collapsedAssistants: c.collapsedAssistants.value,
    searchMatches: props.searchMatches,
  }),
)
const layout = computed(() => layoutLedgerRows(display.value))
const runIndexes = computed(() =>
  indexTrajectoryRequestBoundaryRuns(display.value),
)
const requestsByNumber = computed(
  () =>
    new Map<number, TrajectoryRequestNumber>(
      c.requestNumbers.value.map((request) => [request.number, request]),
    ),
)
const groupDescriptions = computed(() => {
  const map = new Map<string, string>()
  for (const turn of c.turns.value)
    for (const group of turn.groups)
      if (group.description !== undefined)
        map.set(trajectoryRequestKey(turn.turn, group.title), group.description)
  return map
})
const hasMore = computed(() => c.windowState.value.hasMore)
const loadingOlder = computed(() => c.windowState.value.loadingOlder)
const openState = computed(() => c.windowState.value.openState)
const virtual = computed(
  () => hasMore.value || layout.value.rows.length > props.virtualizeThreshold,
)
const listTop = computed(
  () => HEADER_HEIGHT + (hasMore.value ? HISTORY_ROW_HEIGHT : 0),
)
const items = computed(() =>
  layout.value.rows.map((row, position) => ({
    id: row.key,
    size: row.height,
    row,
    position,
  })),
)
const firstIndex = computed(() => c.records.value[0]?.cell.index)

const selectedRequest = computed(() =>
  c.selection.value?.kind === 'request' ? c.selection.value : null,
)
const selectedIndex = computed(() => c.selectedRecord.value?.cell.index ?? null)
const activeTurn = computed(() =>
  selectedRequest.value !== null
    ? selectedRequest.value.turn
    : c.selectedRecord.value?.turn,
)

function markerOf(record: TrajectoryLedgerRecord): RequestMarker | undefined {
  return requestMarkerOf(record, {
    boundaries: c.requestBoundaries.value,
    displayNumbers: c.requestDisplayNumbers.value,
    requestsByNumber: requestsByNumber.value,
    collapsedTurns: c.collapsedTurns.value,
    runIndexes: runIndexes.value,
  })
}

function markersOf(row: LedgerRow) {
  return row.entries.flatMap((entry) => {
    const marker = markerOf(entry.record)
    if (marker === undefined) return []
    const selected =
      selectedRequest.value !== null &&
      selectedRequest.value.turn === marker.turn &&
      selectedRequest.value.group === marker.group
    const description = groupDescriptions.value.get(
      trajectoryRequestKey(marker.turn, marker.group),
    )
    return [
      {
        marker,
        selected,
        ...(description === undefined ? {} : { description }),
      },
    ]
  })
}

function focusOf(
  record: TrajectoryLedgerRecord,
): 'inside' | 'outside' | undefined {
  const focus = props.timelineFocusIndexes
  if (focus === null) return undefined
  return focus.has(record.cell.index) ? 'inside' : 'outside'
}

// ── sticky turn header ─────────────────────────────────────────────────
const topRow = ref(0)
const headerRecord = computed(() => {
  const rows = layout.value.rows
  for (let index = topRow.value; index < rows.length; index++) {
    const content = rows[index]?.content
    if (content !== undefined) return content
  }
  return undefined
})
const headerTotals = computed(() =>
  headerRecord.value === undefined
    ? { timeSeconds: null }
    : turnTotals(c.records.value, headerRecord.value.section),
)

// ── scrolling ──────────────────────────────────────────────────────────
const following = ref(true)
let olderAnchor: { key: string; delta: number } | null = null
let frame = 0

function updateTopRow(): void {
  const el = pane.value
  if (el === null) return
  topRow.value = rowAtOffset(
    layout.value.rows,
    Math.max(0, el.scrollTop - listTop.value + HEADER_HEIGHT),
  )
}

function pinToBottom(): void {
  const el = pane.value
  if (el === null) return
  el.scrollTop = el.scrollHeight
  updateTopRow()
}

function loadOlder(): void {
  const el = pane.value
  if (el === null || !hasMore.value || loadingOlder.value) return
  const rows = layout.value.rows
  const at = rowAtOffset(rows, Math.max(0, el.scrollTop - listTop.value))
  const row = rows[at]
  olderAnchor =
    row === undefined
      ? null
      : { key: row.key, delta: el.scrollTop - (listTop.value + row.top) }
  void c.loadOlder()
}

function onScroll(): void {
  const el = pane.value
  if (el === null) return
  following.value =
    el.scrollHeight - el.clientHeight - el.scrollTop <=
    BOTTOM_FOLLOW_THRESHOLD_PX
  if (el.scrollTop <= OLDER_LOAD_THRESHOLD_PX && !following.value) loadOlder()
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(updateTopRow)
}

function scrollToRow(position: number, align: 'center' | 'start' | 'nearest') {
  const el = pane.value
  const row = layout.value.rows[position]
  if (el === null || row === undefined) return
  const top = listTop.value + row.top
  following.value = false
  if (align === 'nearest') {
    if (top - HEADER_HEIGHT < el.scrollTop) el.scrollTop = top - HEADER_HEIGHT
    else if (top + row.height > el.scrollTop + el.clientHeight)
      el.scrollTop = top + row.height - el.clientHeight
  } else if (align === 'start') el.scrollTop = top - HEADER_HEIGHT
  else el.scrollTop = top - el.clientHeight / 2 + row.height / 2
  updateTopRow()
}

// Rows changed: keep the prepend anchor, else follow the tail.
watch(
  () => layout.value,
  (next) => {
    void nextTick(() => {
      const el = pane.value
      if (el === null) return
      if (olderAnchor !== null) {
        const row = next.rows.find(
          (candidate) => candidate.key === olderAnchor?.key,
        )
        if (row !== undefined) {
          el.scrollTop = listTop.value + row.top + olderAnchor.delta
          olderAnchor = null
          updateTopRow()
          return
        }
      }
      if (following.value) pinToBottom()
      else updateTopRow()
    })
  },
  { flush: 'post' },
)

// Controller scroll requests (inspect deep link, hierarchy links, timeline).
watch(
  () => [c.scrollRequest.value, layout.value] as const,
  ([request]) => {
    if (request === null) return
    const record = display.value.find(
      (candidate) =>
        candidate.collapsedSummary === undefined &&
        trajectoryRecordId(candidate.cell) === request.recordId,
    )
    if (record === undefined) return
    const position = layout.value.rowByRecordIndex.get(record.cell.index)
    if (position === undefined) return
    c.scrollRequest.value = null
    focusPosition.value = position
    void nextTick(() => scrollToRow(position, 'center'))
  },
  { flush: 'post' },
)

// Timeline brush: bring the focused records into view.
watch(
  () => props.timelineFocusIndexes,
  (focus) => {
    if (focus === null || focus.size === 0) return
    const positions = layout.value.rows.flatMap((row, position) =>
      row.content !== undefined &&
      row.content.collapsedSummary === undefined &&
      focus.has(row.content.cell.index)
        ? [position]
        : [],
    )
    const first = positions[0]
    const last = positions.at(-1)
    const el = pane.value
    if (first === undefined || last === undefined || el === null) return
    const rows = layout.value.rows
    const span =
      (rows[last]?.top ?? 0) +
      (rows[last]?.height ?? 0) -
      (rows[first]?.top ?? 0)
    if (span > el.clientHeight) scrollToRow(first, 'start')
    else
      scrollToRow(
        positions[Math.floor((positions.length - 1) / 2)] ?? first,
        'center',
      )
  },
)

onMounted(() => {
  void nextTick(pinToBottom)
})
onBeforeUnmount(() => cancelAnimationFrame(frame))

// ── selection / folding ────────────────────────────────────────────────
const focusPosition = ref(-1)

function selectRecord(index: number): void {
  const position = layout.value.rowByRecordIndex.get(index)
  if (position !== undefined) focusPosition.value = position
  c.selectRecord(index)
  emit('record-select', index)
}

function toggleFold(record: TrajectoryLedgerRecord): void {
  if (record.collapsedSummaryKind === 'turn' && record.turn !== null)
    c.toggleTurn(record.turn)
  else c.toggleAssistant(trajectoryRecordId(record.cell))
}

function activate(record: TrajectoryLedgerRecord): void {
  if (record.turn !== null && c.collapsedTurns.value.has(record.turn)) {
    c.toggleTurn(record.turn)
    return
  }
  if (
    record.cell.kind === 'message' &&
    trajectoryAssistantToolCalls(c.records.value, record.cell.index).length > 0
  ) {
    c.toggleAssistant(trajectoryRecordId(record.cell))
    return
  }
  if (
    record.turnStart &&
    record.turn !== null &&
    turnCollapsible(c.records.value, record.turn)
  )
    c.toggleTurn(record.turn)
}

function selectRequest(marker: RequestMarker): void {
  c.selectRequest({
    turn: marker.turn,
    group: marker.group,
    ...(marker.seq === undefined ? {} : { seq: marker.seq }),
  })
}

function onPaneClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('[role="row"], button') == null) {
    c.clearSelection()
    emit('clear')
  }
}

function onKeydown(event: KeyboardEvent): void {
  const rows = layout.value.rows
  const focusable = rows.map((row) => row.content)
  const action = ledgerKeyAction(event.key, {
    rows: focusable.filter(
      (record): record is TrajectoryLedgerRecord => record !== undefined,
    ),
    position: toFocusable(focusPosition.value),
    records: c.records.value,
    collapsedTurns: c.collapsedTurns.value,
    collapsedAssistants: c.collapsedAssistants.value,
  })
  if (action.kind === 'none') return
  event.preventDefault()
  switch (action.kind) {
    case 'move': {
      const position = fromFocusable(action.position)
      focusPosition.value = position
      const record = rows[position]?.content
      if (record !== undefined && record.collapsedSummary === undefined) {
        c.selectRecord(record.cell.index)
        emit('record-select', record.cell.index)
      }
      scrollToRow(position, 'nearest')
      return
    }
    case 'select':
      selectRecord(action.index)
      return
    case 'toggle-turn':
      c.toggleTurn(action.turn)
      return
    case 'toggle-assistant':
      c.toggleAssistant(action.id)
      return
    case 'clear':
      c.clearSelection()
      emit('clear')
  }
}

/** Row position → position among content rows (terminal markers skipped). */
function toFocusable(position: number): number {
  if (position < 0) return -1
  let count = -1
  const rows = layout.value.rows
  for (let index = 0; index <= position && index < rows.length; index++)
    if (rows[index]?.content !== undefined) count++
  return count
}

function fromFocusable(focusable: number): number {
  let count = -1
  const rows = layout.value.rows
  for (let index = 0; index < rows.length; index++) {
    if (rows[index]?.content !== undefined) count++
    if (count === focusable) return index
  }
  return rows.length - 1
}

defineExpose({ scrollToBottom: pinToBottom, scrollToRow })
</script>

<template>
  <div class="traj-table">
    <div
      ref="pane"
      class="pane"
      role="grid"
      tabindex="0"
      aria-label="Trajectory ledger"
      :aria-rowcount="layout.rows.length"
      :aria-activedescendant="
        focusPosition >= 0 ? `traj-row-${focusPosition}` : undefined
      "
      data-trajectory-scroll
      @scroll.passive="onScroll"
      @click="onPaneClick"
      @keydown="onKeydown"
    >
      <TrajectoryTurnHeader
        class="sticky-header"
        :turn="headerRecord?.turn ?? null"
        :totals="headerTotals"
      />
      <div
        v-if="openState !== 'open'"
        class="history-loading"
        role="status"
        aria-live="polite"
      >
        <span v-if="openState === 'error'" class="error-text">{{
          controller.windowState.value.error ?? 'Failed to load trajectory'
        }}</span>
        <template v-else>
          <span class="spinner" aria-hidden="true" />Loading trajectory…
        </template>
      </div>
      <div v-if="hasMore" class="history-row" data-history-load>
        <button
          type="button"
          class="history-button"
          :disabled="loadingOlder"
          @click.stop="loadOlder"
        >
          <span v-if="loadingOlder" class="spinner" aria-hidden="true" />
          {{
            loadingOlder ? 'Loading earlier history…' : 'Load earlier history'
          }}
        </button>
      </div>
      <p v-if="openState === 'open' && layout.rows.length === 0" class="empty">
        No trajectory records yet
      </p>
      <RecycleScroller
        v-if="virtual"
        class="list"
        :items="items"
        :item-size="null"
        size-field="size"
        key-field="id"
        :buffer="600"
        page-mode
      >
        <template #default="{ item }">
          <TrajectoryCell
            v-if="item.row.content"
            :id="`traj-row-${item.position}`"
            :record="controller.currentRecord(item.row.content)"
            :position="item.position"
            :selected="selectedIndex === item.row.content.cell.index"
            :focused="focusPosition === item.position"
            :turn-active="activeTurn === item.row.content.turn"
            :is-initial-system="
              item.row.content.cell.kind === 'system' &&
              item.row.content.cell.index === firstIndex
            "
            :timeline-focus="focusOf(item.row.content)"
            :markers="markersOf(item.row)"
            @select="selectRecord"
            @toggle-fold="toggleFold"
            @activate="activate"
            @select-request="selectRequest"
          />
          <div v-else class="terminal-row">
            <TrajectoryGroupHeader
              v-for="entry in markersOf(item.row)"
              :key="entry.marker.number"
              :marker="entry.marker"
              :selected="entry.selected"
              @select="selectRequest(entry.marker)"
            />
          </div>
        </template>
      </RecycleScroller>
      <div v-else class="list">
        <template v-for="(row, position) in layout.rows" :key="row.key">
          <TrajectoryCell
            v-if="row.content"
            :id="`traj-row-${position}`"
            :record="controller.currentRecord(row.content)"
            :position="position"
            :selected="selectedIndex === row.content.cell.index"
            :focused="focusPosition === position"
            :turn-active="activeTurn === row.content.turn"
            :is-initial-system="
              row.content.cell.kind === 'system' &&
              row.content.cell.index === firstIndex
            "
            :timeline-focus="focusOf(row.content)"
            :markers="markersOf(row)"
            @select="selectRecord"
            @toggle-fold="toggleFold"
            @activate="activate"
            @select-request="selectRequest"
          />
          <div v-else class="terminal-row">
            <TrajectoryGroupHeader
              v-for="entry in markersOf(row)"
              :key="entry.marker.number"
              :marker="entry.marker"
              :selected="entry.selected"
              @select="selectRequest(entry.marker)"
            />
          </div>
        </template>
      </div>
      <div class="bottom-clearance" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.traj-table {
  --traj-turn-accent: color-mix(
    in srgb,
    rgb(var(--accent-fill)) 22%,
    rgb(var(--bg-layer-1))
  );

  position: relative;
  isolation: isolate;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: rgb(var(--bg-layer-1));
  container: trajectory-table / inline-size;
}

.pane {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  outline: none;
  scrollbar-gutter: stable;
}

.sticky-header {
  position: sticky;
  z-index: var(--z-popover);
  top: 0;
}

.history-loading {
  position: sticky;
  z-index: var(--z-toast);
  top: var(--space-7);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1-5);
  height: 30px;
  border-bottom: 1px solid var(--border-l2);
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-secondary));
  font: var(--font-xxs);
}

.error-text {
  color: rgb(var(--danger));
}

.history-row {
  height: 30px;
  border-bottom: 1px solid var(--border-l1);
}

.history-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1-5);
  width: 100%;
  height: 29px;
  border: 0;
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-secondary));
  cursor: pointer;
  font: var(--font-xxs);
}

.history-button:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.history-button:disabled {
  cursor: default;
}

.spinner {
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border: 1.5px solid var(--border-l2);
  border-top-color: rgb(var(--accent-fill));
  border-radius: 50%;
  animation: traj-spin 700ms linear infinite;
}

@keyframes traj-spin {
  to {
    transform: rotate(360deg);
  }
}

.empty {
  margin: 0;
  padding: var(--space-6) var(--space-4);
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
  text-align: center;
}

.terminal-row {
  position: relative;
  height: 9px;
}

.bottom-clearance {
  height: var(--traj-bottom-clearance, var(--space-4));
}

.pane:focus-visible .traj-row[data-focused='true'] {
  box-shadow: inset 0 0 0 1px rgb(var(--focus-ring));
}
</style>
