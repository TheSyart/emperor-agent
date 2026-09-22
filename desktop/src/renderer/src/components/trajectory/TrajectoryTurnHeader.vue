<script setup lang="ts">
/**
 * TrajectoryTurnHeader — sticky bar at the top of the ledger naming the
 * section under the viewport's top edge (`Turn N` / `Between turns`) with
 * the dsh Input / Output / Think / Time columns (4 × 71px + 3 × 12px lane)
 * holding that turn's totals. The columns drop in a narrow ledger.
 *
 * Props: turn (number | null); totals (TurnTotals).
 */
import { computed } from 'vue'
import { trajectorySectionLabel } from '../../trajectory/model'
import type { TurnTotals } from './ledgerRows'
import { formatCount, formatDurationMs } from './trajectoryFormat'

const props = defineProps<{ turn: number | null; totals: TurnTotals }>()

const columns = computed(() => {
  const count = (value: number | undefined) =>
    value === undefined ? '—' : formatCount(value)
  return [
    { label: 'Input', value: count(props.totals.input) },
    { label: 'Output', value: count(props.totals.output) },
    { label: 'Think', value: count(props.totals.think) },
    {
      label: 'Time',
      value:
        props.totals.timeSeconds === null
          ? '—'
          : formatDurationMs(props.totals.timeSeconds * 1_000),
    },
  ]
})
</script>

<template>
  <div class="traj-turn-header" data-trajectory-turn-header>
    <span class="title">{{ trajectorySectionLabel(turn) }}</span>
    <dl class="columns">
      <div v-for="column in columns" :key="column.label" class="column">
        <dt>{{ column.label }}</dt>
        <dd>{{ column.value }}</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
.traj-turn-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  height: 28px;
  padding: 0 var(--space-4) 0 var(--space-3);
  border-bottom: 1px solid var(--border-l1);
  background: rgb(var(--bg-layer-1));
  user-select: none;
}

.title {
  flex: none;
  color: rgb(var(--label-primary));
  font: 600 var(--fs-xxs) / var(--lh-xxs) var(--font-sans);
}

.columns {
  display: flex;
  flex: none;
  align-items: baseline;
  gap: var(--space-3);
  margin: 0;
}

.column {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  width: 71px;
  min-width: 0;
  white-space: nowrap;
}

dt {
  color: rgb(var(--label-caption));
  font: var(--font-xxxs);
}

dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: rgb(var(--label-secondary));
  font: var(--font-xxxs);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
}

@container trajectory-table (max-width: 620px) {
  .columns {
    display: none;
  }
}
</style>
