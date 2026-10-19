<script setup lang="ts">
/**
 * List — a keyboard-navigable list of ListRows (DS-04): a listbox whose
 * rows are options; ArrowUp / ArrowDown move between them. Group rows with
 * ListSection; a list never draws a card around a card.
 *
 * Props: label? (accessible name; or aria-labelledby as an attribute).
 * Slots: default (ListRow / ListSection).
 */
import { provideList } from './listContext'

defineProps<{ label?: string }>()
provideList()
</script>

<template>
  <div class="ds-list" role="listbox" data-ds-list :aria-label="label">
    <slot />
  </div>
</template>

<style scoped>
.ds-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}
</style>
