<script setup lang="ts">
/**
 * Collapsed sidebar (dsh 56px rail): the brand mark doubles as the expand
 * toggle (hover swaps in the panel icon), then New chat and Search as 36px
 * controls; settings + theme sit at the foot.
 */
import BrandMark from '../brand/BrandMark.vue'
import { DsNewChat, DsPanelLeft, DsSearch } from '../icons/ds'
import Tooltip from '../ui/Tooltip.vue'
import SidebarFooter from './SidebarFooter.vue'

const emit = defineEmits<{ toggle: []; 'new-chat': []; search: [] }>()
</script>

<template>
  <aside class="sidebar-rail" aria-label="会话侧栏（已收起）">
    <Tooltip label="展开侧栏" side="right" :delay-ms="500">
      <button
        type="button"
        class="rail-button toggle"
        aria-label="展开侧栏"
        @click="emit('toggle')"
      >
        <BrandMark :size="24" class="mark" />
        <DsPanelLeft :size="18" class="panel" />
      </button>
    </Tooltip>
    <Tooltip label="新对话" side="right" :delay-ms="500">
      <button
        type="button"
        class="rail-button"
        aria-label="新对话"
        @click="emit('new-chat')"
      >
        <DsNewChat :size="18" />
      </button>
    </Tooltip>
    <Tooltip label="搜索对话" side="right" :delay-ms="500">
      <button
        type="button"
        class="rail-button"
        aria-label="搜索对话"
        @click="emit('search')"
      >
        <DsSearch :size="18" />
      </button>
    </Tooltip>
    <div class="spacer" />
    <SidebarFooter rail />
  </aside>
</template>

<style scoped>
.sidebar-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  box-sizing: border-box;
  height: 100%;
  padding: calc(var(--space-4) + 2px) var(--space-2-5) var(--space-1-5);
  background: rgb(var(--sidebar-fill));
  animation: ds-fade-in var(--duration-ds) var(--ease-in-out);
}

.rail-button {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-primary));
  cursor: pointer;
}

.rail-button:hover {
  background: var(--interactive-bg-hover);
}

.toggle .panel {
  display: none;
}

.toggle:hover {
  background: transparent;
}

.toggle:hover .panel {
  display: inline;
}

.toggle:hover .mark {
  display: none;
}

.spacer {
  flex: 1;
}
</style>
