<script setup lang="ts">
/**
 * InspectorRows — dsh inspector definition list (94px term column, 22px
 * rows, 13/20). Sub-bucket rows (`detail`) indent their term.
 *
 * Props: rows (InspectorRow[]); dense? (preview inside an overview section).
 * Slots: default (extra `<div><dt/><dd/></div>` rows appended).
 */
import type { InspectorRow } from '../trajectoryFormat'

withDefaults(
  defineProps<{ rows?: readonly InspectorRow[]; dense?: boolean }>(),
  { rows: () => [], dense: false },
)
</script>

<template>
  <dl class="traj-rows" :data-dense="dense || undefined">
    <slot name="before" />
    <div
      v-for="row in rows"
      :key="row.label"
      :data-detail="row.detail || undefined"
    >
      <dt>{{ row.label }}</dt>
      <dd :data-tone="row.tone">{{ row.value }}</dd>
    </div>
    <slot />
  </dl>
</template>

<style scoped>
.traj-rows {
  margin: 0;
  padding: var(--space-2) 0;
  font: var(--font-xs);
}

.traj-rows[data-dense='true'] {
  padding: 2px 0 0;
}

.traj-rows > :deep(div) {
  display: grid;
  grid-template-columns: 94px minmax(0, 1fr);
  align-items: center;
  min-height: 22px;
  padding: 0 var(--space-3-5);
}

.traj-rows > :deep(div[data-detail='true']) dt {
  padding-left: var(--space-3);
}

.traj-rows :deep(dt) {
  color: rgb(var(--label-tertiary));
}

.traj-rows :deep(dd) {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.traj-rows :deep(dd[data-tone='error']) {
  color: rgb(var(--danger));
}
</style>
