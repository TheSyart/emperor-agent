<script setup lang="ts">
/**
 * TokenHeatmap — the dsh activity heatmap, fluid: 53 week columns
 * (`repeat(53, minmax(0, 1fr))`) × 7 weekday rows filled column-major,
 * square cells via aspect-ratio (the grid scales with the section, never
 * scrolls), month labels on the same 53-column grid and a 少 → 多 legend.
 * A roving-tabindex grid: arrows move by day / week, Home / End jump; the
 * focused cell's label is announced.
 *
 * Props: view (HeatmapView from heatmapView()), label.
 */
import { nextTick, ref, watch } from 'vue'
import type { HeatmapView } from './tokenUsageModel'

const props = defineProps<{ view: HeatmapView; label: string }>()

const grid = ref<HTMLElement | null>(null)
const focusIndex = ref(lastDated())

watch(
  () => props.view.cells.length,
  () => {
    focusIndex.value = lastDated()
  },
)

function lastDated() {
  for (let index = props.view.cells.length - 1; index >= 0; index -= 1)
    if (props.view.cells[index]?.date) return index
  return 0
}

async function onKeydown(event: KeyboardEvent, index: number) {
  let next = index
  if (event.key === 'ArrowLeft') next -= 7
  else if (event.key === 'ArrowRight') next += 7
  else if (event.key === 'ArrowUp') next -= 1
  else if (event.key === 'ArrowDown') next += 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = lastDated()
  else return
  event.preventDefault()
  const bounded = Math.max(0, Math.min(lastDated(), next))
  focusIndex.value = bounded
  await nextTick()
  grid.value
    ?.querySelector<HTMLElement>(`[data-cell-index="${bounded}"]`)
    ?.focus()
}
</script>

<template>
  <div class="token-heatmap">
    <div class="months" aria-hidden="true">
      <span
        v-for="month in view.months"
        :key="month.key"
        :style="{ gridColumnStart: month.column }"
        >{{ month.label }}</span
      >
    </div>
    <div ref="grid" class="grid" role="grid" :aria-label="label">
      <span
        v-for="(cell, index) in view.cells"
        :key="cell.key"
        class="cell"
        role="gridcell"
        :data-cell-index="index"
        :data-level="cell.level"
        :data-empty="cell.date ? undefined : true"
        :tabindex="cell.date && index === focusIndex ? 0 : -1"
        :title="cell.label || undefined"
        :aria-label="cell.label || undefined"
        :aria-hidden="cell.date ? undefined : true"
        @focus="focusIndex = index"
        @keydown="onKeydown($event, index)"
      />
    </div>
    <p class="visually-hidden" aria-live="polite">
      {{ view.cells[focusIndex]?.label ?? '' }}
    </p>
    <div class="legend" aria-hidden="true">
      <span>少</span>
      <i
        v-for="level in [0, 1, 2, 3, 4]"
        :key="level"
        class="cell swatch"
        :data-level="level"
      />
      <span>多</span>
    </div>
  </div>
</template>

<style scoped>
.token-heatmap {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.months {
  display: grid;
  grid-template-columns: repeat(53, minmax(0, 1fr));
  height: var(--lh-xxxs);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
}

.months span {
  white-space: nowrap;
}

.grid {
  display: grid;
  width: 100%;
  grid-auto-flow: column;
  grid-template-columns: repeat(53, minmax(0, 1fr));
  grid-template-rows: repeat(7, auto);
  gap: 2px;
}

.cell {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  border-radius: 2px;
  background: var(--interactive-bg-hover);
  outline: none;
}

.cell[data-empty] {
  background: transparent;
}

.cell[data-level='1'] {
  background: rgb(var(--accent-fill) / 0.24);
}

.cell[data-level='2'] {
  background: rgb(var(--accent-fill) / 0.44);
}

.cell[data-level='3'] {
  background: rgb(var(--accent-fill) / 0.68);
}

.cell[data-level='4'] {
  background: rgb(var(--accent-fill));
}

.cell:focus-visible {
  position: relative;
  z-index: var(--z-raised);
  box-shadow: 0 0 0 2px rgb(var(--focus-ring));
}

.legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
  margin-top: var(--space-1);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
}

.swatch {
  width: var(--space-2);
  height: var(--space-2);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  border: 0;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
