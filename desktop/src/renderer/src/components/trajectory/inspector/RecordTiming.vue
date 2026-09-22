<script setup lang="ts">
/**
 * RecordTiming — Timing tab of a record: assistant steps show Started /
 * Total / TTFT / Generation / Throughput; other records Started / Duration
 * / Timing source.
 *
 * Props: record; dense?.
 */
import { computed } from 'vue'
import {
  formatElapsedSeconds,
  type TrajectoryLedgerRecord,
} from '../../../trajectory/model'
import { assistantTimingRows, type InspectorRow } from '../trajectoryFormat'
import InspectorRows from './InspectorRows.vue'
import StartedAt from './StartedAt.vue'

const props = withDefaults(
  defineProps<{ record: TrajectoryLedgerRecord; dense?: boolean }>(),
  { dense: false },
)

const metrics = computed(() =>
  props.record.cell.kind === 'message'
    ? props.record.cell.assistantMetrics
    : undefined,
)
const rows = computed((): readonly InspectorRow[] =>
  metrics.value !== undefined
    ? assistantTimingRows(metrics.value)
    : [
        {
          label: 'Duration',
          value: formatElapsedSeconds(props.record.cell.timeSeconds),
        },
        {
          label: 'Timing source',
          value:
            props.record.cell.timeSeconds === null
              ? 'Not available'
              : 'Session timestamps',
        },
      ],
)
</script>

<template>
  <InspectorRows :rows="rows" :dense="dense" data-inspector-timing>
    <template #before>
      <StartedAt
        :timestamp="
          metrics !== undefined ? metrics.stepStartTime : record.cell.startedAt
        "
      />
    </template>
  </InspectorRows>
</template>
