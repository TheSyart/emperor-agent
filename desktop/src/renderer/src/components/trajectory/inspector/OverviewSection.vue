<script setup lang="ts">
/**
 * OverviewSection — one titled preview block of an inspector Summary tab
 * (`Payload ›`, `Usage ›` …); the title opens the full tab.
 *
 * Props: label. Emits: open. Slots: default (preview body).
 */
import DsChevronRight from '../../icons/ds/DsChevronRight.vue'

defineProps<{ label: string }>()
defineEmits<{ open: [] }>()
</script>

<template>
  <section class="traj-overview-section">
    <h3 class="heading">
      <button type="button" class="title" @click="$emit('open')">
        <span>{{ label }}</span>
        <DsChevronRight :size="12" class="title-icon" />
      </button>
    </h3>
    <div class="preview">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.traj-overview-section {
  display: flex;
  flex-direction: column;
  min-height: 28px;
}

.traj-overview-section + .traj-overview-section {
  padding-top: var(--space-2);
}

.heading {
  display: flex;
  align-items: flex-end;
  box-sizing: border-box;
  height: 28px;
  margin: 0;
  padding: 0 0 3px var(--space-3-5);
  color: rgb(var(--label-secondary));
  font: 600 var(--fs-xs) / 1 var(--font-sans);
}

.title {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--space-1) - 1px);
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.title-icon {
  color: rgb(var(--label-caption));
}

.title:hover .title-icon {
  color: rgb(var(--label-primary));
}

.title:focus-visible {
  outline: 1px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.preview {
  max-height: 220px;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
</style>
