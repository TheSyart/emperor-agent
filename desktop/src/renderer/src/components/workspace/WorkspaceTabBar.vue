<script setup lang="ts">
/**
 * WorkspaceTabBar — the editor tab strip 文件 and 终端 share (UI-S06): one
 * Tabs `editor` strip on the canvas fill, the selected tab on the pane's
 * base fill so it joins the content under it, the strip's own action right
 * after the last tab (「+」) and the pane's actions at the far right.
 *
 * Props: tabs (TabItem[]), modelValue (v-model: the active tab id), label
 * (the strip's accessible name).
 * Emits: update:modelValue, close(id).
 * Slots: `after` (right after the tabs), `actions` (far right).
 */
import Tabs from '../ui/Tabs.vue'
import type { TabItem } from '../ui/blockTypes'

defineProps<{ tabs: readonly TabItem[]; label: string }>()
const active = defineModel<string>({ required: true })
const emit = defineEmits<{ close: [id: string] }>()
</script>

<template>
  <div class="workspace-tab-bar">
    <Tabs
      v-model="active"
      class="strip"
      variant="editor"
      :tabs="tabs"
      :aria-label="label"
      @close="emit('close', $event)"
    />
    <div v-if="$slots.after" class="slot"><slot name="after" /></div>
    <div v-if="$slots.actions" class="slot actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
/* 4px over 32px tabs; the hairline runs under the strip and the selected
   tab covers it. */
.workspace-tab-bar {
  display: flex;
  flex: none;
  align-items: flex-end;
  gap: var(--space-0-5);
  box-sizing: border-box;
  height: calc(var(--control-md) + var(--space-1));
  min-width: 0;
  padding: 0 var(--space-1-5) 0 var(--space-1);
  background: rgb(var(--surface-canvas));
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.strip {
  flex: 0 1 auto;
  min-width: 0;
}

.strip :deep(.tab-item[data-active]) {
  box-shadow:
    -0.5px 0 0 var(--hairline),
    0.5px 0 0 var(--hairline);
}

.slot {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  height: var(--control-md);
}

.actions {
  margin-left: auto;
}
</style>
