<script setup lang="ts">
/**
 * ListSection — a labelled group of rows inside a List (DS-04): a 12/18
 * medium tertiary label, then the rows, separated by 0.5px hairlines
 * inset 16px from the left.
 *
 * Props: title? (or the `title` slot).
 * Slots: title, default (ListRow).
 */
import { useId } from 'vue'

defineProps<{ title?: string }>()
const titleId = `ds-list-section-${useId()}`
</script>

<template>
  <div
    class="ds-list-section"
    role="group"
    :aria-labelledby="title || $slots.title ? titleId : undefined"
  >
    <div v-if="title || $slots.title" :id="titleId" class="section-title">
      <slot name="title">{{ title }}</slot>
    </div>
    <div class="rows"><slot /></div>
  </div>
</template>

<style scoped>
.ds-list-section {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ds-list-section + .ds-list-section {
  margin-top: var(--space-3);
}

.section-title {
  padding: var(--space-1) var(--space-2);
  color: rgb(var(--text-3));
  font: var(--weight-medium) var(--type-caption) var(--font-sans);
}

.rows {
  display: flex;
  flex-direction: column;
}

.rows :deep(.ds-list-row + .ds-list-row)::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  left: var(--list-inset);
  height: 0.5px;
  background: var(--hairline);
  pointer-events: none;
}

/* A filled (selected) row needs no line on either side. */
.rows :deep(.ds-list-row[data-selected])::before,
.rows :deep(.ds-list-row[data-selected] + .ds-list-row)::before {
  content: none;
}
</style>
