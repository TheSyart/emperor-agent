<script setup lang="ts">
/**
 * Brand row: the mode switcher (the mark + 「Emperor Chat ▾」, MOD-02), then
 * the conversation search toggle (⌘K) and the notification bell.
 */
import type { AppMode, ModeActivity } from '../../runtime/appMode'
import { DsSearch } from '../icons/ds'
import IconButton from '../ui/IconButton.vue'
import ModeSwitcher from './ModeSwitcher.vue'
import SidebarBell from './SidebarBell.vue'

defineProps<{
  searchActive?: boolean
  mode: AppMode
  activity: Record<AppMode, ModeActivity>
  compact?: boolean
}>()
const emit = defineEmits<{ search: []; 'select-mode': [mode: AppMode] }>()
</script>

<template>
  <div class="brand-row">
    <ModeSwitcher
      :mode="mode"
      :activity="activity"
      :compact="compact"
      @select="emit('select-mode', $event)"
    />
    <!-- mousedown.prevent: a click toggles the capsule instead of blurring
         (and so closing) it first. -->
    <IconButton
      label="搜索"
      :active="searchActive"
      @mousedown.prevent
      @click="emit('search')"
    >
      <DsSearch :size="16" />
    </IconButton>
    <SidebarBell />
  </div>
</template>

<style scoped>
.brand-row {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  height: calc(var(--space-8) + var(--space-2));
  margin-bottom: var(--space-1);
}
</style>
