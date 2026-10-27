<script setup lang="ts">
/**
 * Collapsed sidebar (56px rail): the brand mark doubles as the expand
 * toggle (hover swaps in the panel icon), then the three modes (MOD-02:
 * the current one highlighted, a click switches, a dot on a mode where a
 * question waits), back / forward, the mode's new-session entry, search
 * and the bell, the pages (Pull Request in Build only), and settings at
 * the foot. Every control is a 36px circle with a right-side tooltip.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppContext } from '../../composables/useAppContext'
import type { AppMode, ModeActivity } from '../../runtime/appMode'
import { detectShortcutPlatform, shortcutLabel } from '../../shortcuts'
import BrandMark from '../brand/BrandMark.vue'
import { goBack, goForward, useNavHistory } from '../shell/navHistory'
import { DsPanelLeft, DsSearch } from '../icons/ds'
import Dot from '../ui/Dot.vue'
import IconButton from '../ui/IconButton.vue'
import Tooltip from '../ui/Tooltip.vue'
import { COMING_SOON, MODE_ENTRIES, modeEntry } from './modeEntries'
import SidebarBell from './SidebarBell.vue'
import SidebarFooter from './SidebarFooter.vue'
import {
  activeSidebarPage,
  SIDEBAR_ICONS,
  visibleSidebarPages,
  type SidebarPageEntry,
} from './sidebarNav'

const props = defineProps<{
  mode: AppMode
  activity: Record<AppMode, ModeActivity>
}>()
const emit = defineEmits<{
  toggle: []
  'new-session': []
  search: []
  'select-mode': [mode: AppMode]
}>()

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()
const nav = useNavHistory()
const platform = detectShortcutPlatform()
const active = computed(() => activeSidebarPage(route.name))
const pages = computed(() =>
  visibleSidebarPages(ctx.boot.value?.plugins ?? [], props.mode),
)
const primary = computed(() => modeEntry(props.mode).primary)

function newSession(): void {
  if (primary.value.ready) emit('new-session')
}

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
    <div class="modes" role="group" aria-label="模式">
      <IconButton
        v-for="entry in MODE_ENTRIES"
        :key="entry.mode"
        class="mode"
        size="lg"
        shape="circle"
        side="right"
        :label="entry.name"
        :shortcut="shortcutLabel(entry.shortcut, platform)"
        :selected="entry.mode === mode"
        :aria-pressed="String(entry.mode === mode)"
        :data-rail-mode="entry.mode"
        @click="emit('select-mode', entry.mode)"
      >
        <component :is="entry.icon" :size="16" />
        <Dot
          v-if="entry.mode !== mode && activity[entry.mode].waiting"
          class="mode-dot"
          state="attention"
          size="sm"
        />
      </IconButton>
    </div>
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
      <Tooltip
        :label="primary.ready ? primary.label : COMING_SOON"
        side="right"
        :delay-ms="500"
      >
        <button
          type="button"
          class="rail-button"
          :aria-label="primary.label"
          :aria-disabled="primary.ready ? undefined : 'true'"
          @click="newSession"
        >
          <component :is="primary.icon" :size="18" />
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
        v-for="entry in pages"
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
  animation: ds-fade-in var(--motion-base) var(--ease-standard);
}

.group {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding-top: var(--space-2);
  border-top: 1px solid var(--stroke-1);
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
  color: rgb(var(--text-1));
  cursor: pointer;
}

.rail-button:hover:not(:disabled) {
  background: var(--surface-hover);
}

.rail-button[aria-current='page'] {
  background: var(--surface-active);
}

.rail-button:disabled,
.rail-button[aria-disabled='true'] {
  opacity: 0.35;
  cursor: default;
}

/* The three modes, right under the mark (MOD-02). */
.modes {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

.mode {
  position: relative;
  color: rgb(var(--text-2));
}

.mode-dot {
  position: absolute;
  top: var(--space-1-5);
  right: var(--space-1-5);
  box-shadow: 0 0 0 2px rgb(var(--sidebar-fill));
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
