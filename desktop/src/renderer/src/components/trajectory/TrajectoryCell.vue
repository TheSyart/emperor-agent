<script setup lang="ts">
/**
 * TrajectoryCell — one 30px ledger row of the dsh trajectory table: an
 * event column (turn label on the turn's first row, turn / selection rails,
 * request boundary markers, kind tag) and a one-line content column (record
 * summary; tool rows show `name args → result`). Folded summary rows are
 * 20px `… N steps · M tool calls` rows that unfold on click.
 *
 * Props: record (with live content), position (0-based display position),
 * selected, focused (keyboard cursor), turnActive (turn rail), isInitialSystem, timelineFocus
 * ('inside' | 'outside' | undefined), markers (request markers drawn on the
 * row's top boundary, with their selected state).
 * Emits: select(index), toggle-fold(record), activate(record) (dblclick),
 * select-request(marker), focus-row(position).
 */
import { computed } from 'vue'
import {
  isTrajectoryToolCallOnly,
  trajectoryRecordDisplayText,
  trajectoryRecordResultText,
  trajectoryRecordState,
  trajectorySectionLabel,
  trajectoryToolCallTextParts,
  type TrajectoryLedgerRecord,
} from '../../trajectory/model'
import TrajectoryGroupHeader from './TrajectoryGroupHeader.vue'
import TrajectoryKindTag from './TrajectoryKindTag.vue'
import type { RequestMarker } from './ledgerRows'
import { TRAJECTORY_KIND_LABEL } from './trajectoryFormat'

const props = withDefaults(
  defineProps<{
    record: TrajectoryLedgerRecord
    position: number
    selected?: boolean
    focused?: boolean
    turnActive?: boolean
    isInitialSystem?: boolean
    timelineFocus?: 'inside' | 'outside'
    markers?: readonly {
      readonly marker: RequestMarker
      readonly selected: boolean
      readonly description?: string
    }[]
  }>(),
  {
    selected: false,
    focused: false,
    turnActive: false,
    isInitialSystem: false,
    timelineFocus: undefined,
    markers: () => [],
  },
)
const emit = defineEmits<{
  select: [index: number]
  'toggle-fold': [record: TrajectoryLedgerRecord]
  activate: [record: TrajectoryLedgerRecord]
  'select-request': [marker: RequestMarker]
  'focus-row': [position: number]
}>()

const cell = computed(() => props.record.cell)
const summary = computed(() => props.record.collapsedSummary)
const displayText = computed(() => trajectoryRecordDisplayText(cell.value))
const resultText = computed(() => trajectoryRecordResultText(cell.value))
const toolCallOnly = computed(() => isTrajectoryToolCallOnly(cell.value))
const toolParts = computed(() =>
  trajectoryToolCallTextParts(cell.value.kind, displayText.value),
)
const listText = computed(() => {
  if (toolCallOnly.value) return '(tool call only)'
  const parts = toolParts.value
  if (parts === undefined) return displayText.value
  return [parts.name, parts.args].filter(Boolean).join(' ')
})
const state = computed(() => trajectoryRecordState(cell.value))
const ariaLabel = computed(() =>
  summary.value !== undefined
    ? `Collapsed ${props.record.collapsedSummaryKind} summary, ${summary.value}`
    : `${TRAJECTORY_KIND_LABEL[cell.value.kind]}, ${listText.value || 'no content'}`,
)

function onClick(): void {
  if (summary.value !== undefined) emit('toggle-fold', props.record)
  else emit('select', cell.value.index)
}
</script>

<template>
  <div
    class="traj-row"
    role="row"
    tabindex="-1"
    :aria-rowindex="position + 1"
    :aria-label="ariaLabel"
    :aria-selected="summary === undefined ? selected : undefined"
    :data-kind="cell.kind"
    :data-position="position"
    :data-record-index="summary === undefined ? cell.index : undefined"
    :data-turn-start="record.turnStart || undefined"
    :data-turn-end="record.turnEnd || undefined"
    :data-group-start="record.groupStart || undefined"
    :data-error="cell.isError || undefined"
    :data-running="state === 'running' || undefined"
    :data-selected="(summary === undefined && selected) || undefined"
    :data-focused="focused || undefined"
    :data-collapsed-summary="record.collapsedSummaryKind"
    :data-timeline-focus="summary === undefined ? timelineFocus : undefined"
    @click="onClick"
    @dblclick="summary === undefined && $emit('activate', record)"
    @focus="$emit('focus-row', position)"
  >
    <div class="event" role="gridcell">
      <TrajectoryGroupHeader
        v-for="entry in markers"
        :key="`${entry.marker.turn}:${entry.marker.group}`"
        :marker="entry.marker"
        :selected="entry.selected"
        :description="entry.description"
        @select="$emit('select-request', entry.marker)"
      />
      <span
        v-if="record.turn !== null && turnActive && !isInitialSystem"
        class="turn-rail"
        aria-hidden="true"
      />
      <span
        v-if="summary === undefined && selected"
        class="selection-rail"
        aria-hidden="true"
      />
      <span
        v-if="summary === undefined && record.turnStart"
        class="turn-label"
        :data-active="turnActive || undefined"
        :aria-label="trajectorySectionLabel(record.turn)"
      >
        <span class="turn-label-full" aria-hidden="true">{{
          trajectorySectionLabel(record.turn)
        }}</span>
        <span
          v-if="record.turn !== null"
          class="turn-label-compact"
          aria-hidden="true"
          >#{{ record.turn }}</span
        >
      </span>
      <span v-if="summary === undefined" class="kind-slot">
        <TrajectoryKindTag :kind="cell.kind" />
      </span>
    </div>
    <div class="content" role="gridcell">
      <span v-if="summary !== undefined" class="collapsed" :title="summary">
        <span class="collapsed-ellipsis">…</span>
        <span class="collapsed-text">{{ summary }}</span>
      </span>
      <span
        v-else
        :class="resultText === undefined ? 'content-text' : 'result-preview'"
        :title="
          resultText === undefined ? listText : `${listText} → ${resultText}`
        "
      >
        <span :class="{ 'result-request': resultText !== undefined }">
          <span v-if="toolCallOnly" class="tool-call-only"
            >(tool call only)</span
          >
          <template v-else-if="toolParts !== undefined">
            <span class="tool-name">{{ toolParts.name || '—' }}</span>
            <span v-if="toolParts.args !== undefined" class="tool-args">{{
              toolParts.args
            }}</span>
          </template>
          <template v-else>{{ displayText || '—' }}</template>
        </span>
        <span
          v-if="resultText !== undefined"
          class="inline-result"
          :data-error="cell.isError || undefined"
        >
          <span class="arrow">→</span>
          <span
            class="inline-result-text"
            :data-empty="resultText === 'No output' || undefined"
            >{{ resultText }}</span
          >
        </span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.traj-row {
  position: relative;
  display: grid;
  grid-template-columns: var(--traj-event-width, 122px) minmax(0, 1fr);
  box-sizing: border-box;
  height: 30px;
  border-bottom: 1px solid var(--border-l1);
  color: rgb(var(--label-primary));
  font: var(--font-xxs);
  outline: none;
  cursor: default;
  transition:
    background-color var(--duration-fast) var(--ease-in-out),
    opacity var(--duration-fast) var(--ease-in-out);
}

.traj-row:not([data-selected='true']):hover {
  background: var(--interactive-bg-hover);
}

.traj-row:has(.traj-request-marker:hover):not([data-selected='true']) {
  background: transparent;
}

.traj-row[data-selected='true'] {
  background: var(--interactive-bg-active);
}

.traj-row:focus-visible {
  box-shadow: inset 0 0 0 1px rgb(var(--focus-ring));
}

.traj-row[data-timeline-focus='outside'] {
  opacity: 0.24;
}

.traj-row[data-collapsed-summary] {
  height: 20px;
  cursor: pointer;
}

/* Turn boundary: a 2px rule on the top edge of a turn's first row. */
.traj-row[data-turn-start='true']:not([data-position='0'])::before {
  position: absolute;
  z-index: var(--z-base);
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  background: var(--border-l1);
  content: '';
  pointer-events: none;
  transform: translateY(-50%);
}

.event {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 var(--space-1) 0 calc(var(--space-8) + var(--space-1));
}

.content {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  padding: 0 var(--space-2) 0 var(--space-1);
}

.traj-row[data-kind='subtool'] .content {
  padding-left: calc(var(--space-6) + 2px);
}

.kind-slot {
  display: flex;
  flex: none;
  justify-content: flex-end;
  width: 76px;
}

.turn-rail,
.selection-rail {
  position: absolute;
  left: 0;
  pointer-events: none;
}

.turn-rail {
  z-index: var(--z-sticky);
  top: -1px;
  bottom: -1px;
  width: 2px;
  background: var(--traj-turn-accent);
}

.traj-row[data-turn-end='true'] .turn-rail {
  bottom: 0;
}

.selection-rail {
  z-index: var(--z-overlay);
  top: 0;
  bottom: 0;
  width: 3px;
  background: rgb(var(--accent-fill));
}

.traj-row[data-error='true'] .turn-rail {
  background: color-mix(
    in srgb,
    rgb(var(--danger)) 22%,
    rgb(var(--bg-layer-1))
  );
}

.traj-row[data-error='true'] .selection-rail {
  background: rgb(var(--danger));
}

.turn-label {
  position: absolute;
  z-index: var(--z-raised);
  top: 0;
  left: 0;
  display: inline-grid;
  align-items: center;
  box-sizing: border-box;
  width: max-content;
  padding: 1px calc(var(--space-1) + 1px);
  border-radius: 0 0 2px;
  color: rgb(var(--label-tertiary));
  background: var(--interactive-bg-hover);
  font: 8px / 10px var(--font-mono);
  font-variant-numeric: tabular-nums;
  user-select: none;
  white-space: nowrap;
}

.turn-label[data-active='true'] {
  color: color-mix(
    in srgb,
    rgb(var(--accent-strong)) 70%,
    rgb(var(--label-tertiary))
  );
  background: var(--traj-turn-accent);
}

.turn-label-full,
.turn-label-compact {
  grid-area: 1 / 1;
  white-space: nowrap;
}

.turn-label-compact {
  display: none;
}

.content-text,
.result-request,
.inline-result-text,
.collapsed-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-text {
  display: block;
}

.result-preview {
  display: grid;
  grid-template-columns:
    clamp(180px, var(--traj-tool-request-width, calc(36cqw - 56px)), 480px)
    minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}

.traj-row[data-kind='tool'] .content,
.traj-row[data-kind='subtool'] .content {
  font: var(--font-code-small);
}

.tool-name {
  color: rgb(var(--label-primary));
  font: 400 12px / 18px var(--font-mono);
}

.tool-args {
  margin-left: calc(var(--space-1-5) + 1px);
  color: rgb(var(--label-secondary));
}

.tool-call-only {
  color: rgb(var(--label-tertiary));
}

.inline-result {
  display: flex;
  align-items: center;
  min-width: 0;
  color: rgb(var(--label-secondary));
}

.inline-result[data-error='true'] {
  color: rgb(var(--danger));
}

.inline-result-text[data-empty='true'] {
  color: rgb(var(--label-caption));
}

.arrow {
  flex: none;
  margin-right: var(--space-2);
  color: rgb(var(--label-caption));
}

.collapsed {
  display: flex;
  align-items: center;
  min-width: 0;
  color: rgb(var(--label-secondary));
  font: var(--font-xxs);
  line-height: 16px;
}

.collapsed-ellipsis {
  flex: none;
  margin-right: var(--space-1-5);
  color: rgb(var(--label-tertiary));
  font-weight: 600;
}

@container trajectory-table (max-width: 620px) {
  .traj-row {
    --traj-event-width: 50px;
  }

  .event {
    padding: 0 calc(var(--space-1) - 1px) 0 var(--space-7);
  }

  .kind-slot {
    width: 19px;
  }

  .turn-label-full {
    display: none;
  }

  .turn-label-compact {
    display: inline;
  }
}
</style>
