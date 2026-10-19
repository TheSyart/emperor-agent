<script setup lang="ts">
/**
 * The sidebar's 46px top bar (UI-S01): the Emperor mark and name (display
 * only), then the collapse button. It is a window drag region (the button
 * stays clickable) and starts after the traffic lights, which reach into
 * the sidebar from the rail (`--shell-lights-clear`).
 */
import BrandMark from '../brand/BrandMark.vue'
import { DsPanelLeft } from '../icons/ds'
import IconButton from '../ui/IconButton.vue'
import { detectShortcutPlatform, shortcutLabel } from '../../shortcuts'

const emit = defineEmits<{ toggle: [] }>()
const shortcut = shortcutLabel('sidebar.toggle', detectShortcutPlatform())
</script>

<template>
  <div class="sidebar-bar" data-app-drag>
    <div class="brand" data-testid="sidebar-brand">
      <BrandMark :size="20" />
      <span class="brand-name">Emperor</span>
    </div>
    <IconButton label="收起侧栏" :shortcut="shortcut" @click="emit('toggle')">
      <DsPanelLeft :size="16" />
    </IconButton>
  </div>
</template>

<style scoped>
.sidebar-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  height: var(--shell-bar-h);
  padding: 0 var(--space-2) 0 calc(var(--shell-lights-clear) - var(--rail-w));
}

.brand {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin-right: auto;
  color: inherit;
  user-select: none;
}

.brand-name {
  overflow: hidden;
  font: var(--weight-semibold) var(--type-title-sm) var(--font-sans);
  white-space: nowrap;
}
</style>
