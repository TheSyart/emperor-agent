<script setup lang="ts">
/**
 * Collapsed sidebar (56px rail): the brand mark doubles as the expand
 * toggle (hover swaps in the panel icon), then back / forward, new chat,
 * search and the bell, the four full pages, and settings at the foot.
 * Every control is a 36px circle with a right-side tooltip.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandMark from '../brand/BrandMark.vue'
import { goBack, goForward, useNavHistory } from '../shell/navHistory'
import { DsNewChat, DsPanelLeft, DsSearch } from '../icons/ds'
import Tooltip from '../ui/Tooltip.vue'
import SidebarBell from './SidebarBell.vue'
import SidebarFooter from './SidebarFooter.vue'
import {
  activeSidebarPage,
  SIDEBAR_ICONS,
  SIDEBAR_PAGES,
  type SidebarPageEntry,
} from './sidebarNav'

const emit = defineEmits<{ toggle: []; 'new-chat': []; search: [] }>()

const route = useRoute()
const router = useRouter()
const nav = useNavHistory()
const active = computed(() => activeSidebarPage(route.name))

function go(entry: SidebarPageEntry): void {
  void router.push(entry.to).catch(() => undefined)
}
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
    <div class="group">
      <Tooltip label="后退" side="right" :delay-ms="500">
        <button
          type="button"
          class="rail-button"
          aria-label="后退"
          :disabled="!nav.canGoBack"
          @click="goBack(router)"
        >
          <component :is="SIDEBAR_ICONS.back" :size="18" />
        </button>
      </Tooltip>
      <Tooltip label="前进" side="right" :delay-ms="500">
        <button
          type="button"
          class="rail-button"
          aria-label="前进"
          :disabled="!nav.canGoForward"
          @click="goForward(router)"
        >
          <component :is="SIDEBAR_ICONS.forward" :size="18" />
        </button>
      </Tooltip>
    </div>
    <div class="group">
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
      <SidebarBell rail />
    </div>
    <nav class="group" aria-label="侧栏导航">
      <Tooltip
        v-for="entry in SIDEBAR_PAGES"
        :key="entry.name"
        :label="entry.label"
        side="right"
        :delay-ms="500"
      >
        <button
          type="button"
          class="rail-button"
          :aria-label="entry.label"
          :aria-current="active === entry.name ? 'page' : undefined"
          @click="go(entry)"
        >
          <component :is="entry.icon" :size="18" />
        </button>
      </Tooltip>
    </nav>
    <div class="spacer" />
    <SidebarFooter rail />
  </aside>
</template>

<style scoped>
.sidebar-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  height: 100%;
  padding: var(--space-3) var(--space-2-5) var(--space-1-5);
  overflow-y: auto;
  scrollbar-width: none;
  background: rgb(var(--sidebar-fill));
  animation: ds-fade-in var(--duration-ds) var(--ease-in-out);
}

.group {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-l1);
}

.rail-button {
  display: inline-grid;
  place-items: center;
  width: calc(var(--space-8) + var(--space-1));
  height: calc(var(--space-8) + var(--space-1));
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-primary));
  cursor: pointer;
}

.rail-button:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
}

.rail-button[aria-current='page'] {
  background: var(--interactive-bg-active);
}

.rail-button:disabled {
  opacity: 0.35;
  cursor: default;
}

.rail-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.toggle .panel {
  display: none;
}

.rail-button.toggle:hover {
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
