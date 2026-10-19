<script setup lang="ts">
/**
 * PaneHeader — the 48px bar at the top of a pane (DS-04): title, optional
 * Tabs, then the actions on the right. Its height never changes with what
 * it holds (long titles truncate, tabs fill the bar's height).
 *
 * Props: title? (or the `title` slot), divider (a bottom hairline; default
 * true).
 * Slots: leading (a glyph or back button), title, tabs (a Tabs strip),
 * actions (IconButtons / Buttons).
 */
withDefaults(defineProps<{ title?: string; divider?: boolean }>(), {
  title: undefined,
  divider: true,
})
</script>

<template>
  <header class="ds-pane-header" :data-divider="divider || undefined">
    <span v-if="$slots.leading" class="leading"><slot name="leading" /></span>
    <div v-if="title || $slots.title" class="title">
      <slot name="title">{{ title }}</slot>
    </div>
    <div v-if="$slots.tabs" class="tabs"><slot name="tabs" /></div>
    <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.ds-pane-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-3);
  box-sizing: border-box;
  height: var(--pane-header-h);
  min-height: var(--pane-header-h);
  max-height: var(--pane-header-h);
  min-width: 0;
  padding: 0 var(--space-3) 0 var(--space-4);
  overflow: hidden;
}

.ds-pane-header[data-divider] {
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: rgb(var(--text-2));
}

.title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--text-1));
  font: var(--weight-semibold) var(--type-body-sm) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tabs {
  display: flex;
  align-self: stretch;
  min-width: 0;
}

.tabs :deep(.ds-tabs[data-variant='underline']) {
  align-self: stretch;
}

.tabs :deep(.ds-tabs[data-variant='underline'] .tab) {
  height: 100%;
}

.tabs :deep(.ds-tabs[data-variant='segmented']),
.tabs :deep(.ds-tabs[data-variant='editor']) {
  align-self: center;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}
</style>
