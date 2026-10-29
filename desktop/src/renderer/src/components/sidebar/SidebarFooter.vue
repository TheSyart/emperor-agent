<script setup lang="ts">
/**
 * Sidebar foot: the 设置 row (settings modal), the page icons — Pull
 * Request (Build only, with the GitHub plugin on), 定时任务, 能力 (D4 of
 * 0.3, MOD-02) — and the light / dark theme toggle. `rail` renders 设置 and
 * the toggle as 36px circles at the bottom of the collapsed rail, with
 * right-side tooltips; the rail lists the pages itself. The toggle pins an
 * explicit theme; 跟随系统 is chosen in Settings › 常规.
 */
import IconButton from '../ui/IconButton.vue'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppContext } from '../../composables/useAppContext'
import { useContactBrowser } from '../../composables/useContactBrowser'
import { useTheme } from '../../composables/useTheme'
import { DsDark, DsLight, DsSettings, DsUser } from '../icons/ds'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import Tooltip from '../ui/Tooltip.vue'
import {
  activeSidebarPage,
  visibleSidebarPages,
  type SidebarPageEntry,
} from './sidebarNav'

withDefaults(defineProps<{ rail?: boolean }>(), { rail: false })

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()
const settings = useSettingsRoute()
const { theme, toggle } = useTheme()
const contactBrowser = useContactBrowser()

const pages = computed(() =>
  visibleSidebarPages(ctx.boot.value?.plugins ?? [], ctx.appMode.mode.value),
)
const active = computed(() => activeSidebarPage(route.name))
const themeLabel = computed(() =>
  theme.value === 'dark' ? '切换浅色' : '切换深色',
)
const themeIcon = computed(() => (theme.value === 'dark' ? DsLight : DsDark))

function go(entry: SidebarPageEntry): void {
  void router.push(entry.to).catch(() => undefined)
}
</script>

<template>
  <div class="sidebar-footer" :data-rail="rail || undefined">
    <Tooltip label="设置" :disabled="!rail" side="right" :delay-ms="500">
      <button
        type="button"
        class="settings"
        aria-label="设置"
        @click="settings.openSettings('general')"
      >
        <DsSettings :size="rail ? 18 : 16" />
        <span v-if="!rail" class="label">设置</span>
      </button>
    </Tooltip>
    <template v-if="!rail">
      <IconButton
        v-for="entry in pages"
        :key="entry.name"
        class="page"
        :label="entry.label"
        :selected="active === entry.name"
        :aria-current="active === entry.name ? 'page' : undefined"
        :data-sidebar-page="entry.name"
        @click="go(entry)"
      >
        <component :is="entry.icon" :size="16" />
      </IconButton>
    </template>
    <IconButton
      v-if="ctx.appMode.mode.value === 'group'"
      class="contacts"
      label="联系人"
      :selected="contactBrowser.active.value"
      :aria-current="contactBrowser.active.value ? 'page' : undefined"
      :side="rail ? 'right' : 'top'"
      data-testid="sidebar-contacts-toggle"
      @click="contactBrowser.toggle()"
    >
      <DsUser :size="rail ? 18 : 16" />
    </IconButton>
    <IconButton
      class="theme"
      :label="themeLabel"
      :side="rail ? 'right' : 'top'"
      data-testid="sidebar-theme-toggle"
      @click="toggle()"
    >
      <component :is="themeIcon" :size="rail ? 18 : 16" />
    </IconButton>
  </div>
</template>

<style scoped>
.sidebar-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-1) calc(0px - var(--space-0-5));
}

.sidebar-footer > :first-child {
  flex: 1;
  min-width: 0;
}

.sidebar-footer[data-rail] {
  flex-direction: column;
  margin: var(--space-2) 0 var(--space-2-5);
}

.sidebar-footer[data-rail] > :first-child {
  flex: none;
}

.settings {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  width: 100%;
  height: calc(var(--space-8) + var(--space-2-5));
  padding: 0 var(--space-2-5) 0 var(--space-2);
  border: none;
  border-radius: var(--radius-card);
  background: transparent;
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  cursor: pointer;
  overflow: hidden;
}

.settings:hover,
.theme:hover,
.page:hover {
  background: var(--surface-hover);
}

[data-rail] .settings {
  justify-content: center;
  width: calc(var(--space-8) + var(--space-1));
  height: calc(var(--space-8) + var(--space-1));
  padding: 0;
  border-radius: var(--radius-pill);
}

.label {
  overflow: hidden;
  white-space: nowrap;
}

/* The page icons and the theme toggle: one row of 36px circles. */
.page,
.theme {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: calc(var(--space-8) + var(--space-1));
  height: calc(var(--space-8) + var(--space-1));
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--text-2));
  cursor: pointer;
}

.page[aria-current='page'] {
  background: rgb(var(--surface-selected));
  color: rgb(var(--text-1));
}

.settings:focus-visible,
.theme:focus-visible,
.page:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}
</style>
