<script setup lang="ts">
/**
 * The permanent 56px icon rail (UI-S01). Its top area is empty canvas that
 * holds the macOS traffic lights and moves the window (`data-app-drag`, no
 * control in it). Below: 新对话, 搜索, 会话, then the full pages — 定时任务,
 * 能力, 探索 (until UI-S08 folds it into 能力) and Pull Request (only while
 * the GitHub plugin is on); at the foot the bell and 设置. Buttons are the
 * 36px IconButton with 20px glyphs and right-side tooltips; the entry of the
 * current route sits on `--surface-selected`.
 *
 * 会话 is selected on every conversation route: there it shows or hides the
 * sidebar (⌘B), elsewhere it returns to the conversation.
 *
 * Props: sidebarCollapsed. Emits: new-chat, search, toggle-sidebar.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppContext } from '../../composables/useAppContext'
import { isConversationRoute, sessionLocation } from '../../router'
import { detectShortcutPlatform, shortcutLabel } from '../../shortcuts'
import { githubPluginOn } from '../pages/github/githubModel'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import { DsNewChat, DsSearch, DsSettings } from '../icons/ds'
import IconButton from '../ui/IconButton.vue'
import SidebarBell from './SidebarBell.vue'
import {
  activeSidebarPage,
  SIDEBAR_ICONS,
  SIDEBAR_PAGES,
  type SidebarPageEntry,
} from './sidebarNav'

const props = defineProps<{ sidebarCollapsed: boolean }>()
const emit = defineEmits<{
  'new-chat': []
  search: []
  'toggle-sidebar': []
}>()

const route = useRoute()
const router = useRouter()
const ctx = useAppContext()
const settings = useSettingsRoute()
const platform = detectShortcutPlatform()

const active = computed(() => activeSidebarPage(route.name))
const onConversation = computed(() => isConversationRoute(route.name))
const pages = computed(() => {
  const github = githubPluginOn(ctx.boot.value?.plugins ?? [])
  return SIDEBAR_PAGES.filter((entry) => !entry.github || github)
})
const sessionsTooltip = computed(() => {
  if (!onConversation.value) return '会话'
  return props.sidebarCollapsed ? '展开会话列表' : '收起会话列表'
})

function go(entry: SidebarPageEntry): void {
  void router.push(entry.to).catch(() => undefined)
}

function sessions(): void {
  if (onConversation.value) {
    emit('toggle-sidebar')
    return
  }
  void router.push(sessionLocation(ctx.sessionId.value)).catch(() => undefined)
}
</script>

<template>
  <nav class="app-rail" aria-label="应用导航">
    <div class="rail-top" data-app-drag aria-hidden="true" />
    <div class="group" data-rail-group="main">
      <IconButton
        size="lg"
        label="新对话"
        side="right"
        :shortcut="shortcutLabel('session.new', platform)"
        @click="emit('new-chat')"
      >
        <DsNewChat :size="20" />
      </IconButton>
      <IconButton
        size="lg"
        label="搜索"
        tooltip="搜索对话"
        side="right"
        :shortcut="shortcutLabel('search', platform)"
        @click="emit('search')"
      >
        <DsSearch :size="20" />
      </IconButton>
      <IconButton
        size="lg"
        label="会话"
        side="right"
        :tooltip="sessionsTooltip"
        :shortcut="
          onConversation ? shortcutLabel('sidebar.toggle', platform) : ''
        "
        :selected="onConversation"
        :aria-current="onConversation ? 'page' : undefined"
        :aria-expanded="onConversation ? !sidebarCollapsed : undefined"
        @click="sessions"
      >
        <component :is="SIDEBAR_ICONS.sessions" :size="20" />
      </IconButton>
      <IconButton
        v-for="entry in pages"
        :key="entry.name"
        size="lg"
        side="right"
        :label="entry.label"
        :selected="active === entry.name"
        :aria-current="active === entry.name ? 'page' : undefined"
        @click="go(entry)"
      >
        <component :is="entry.icon" :size="20" />
      </IconButton>
    </div>
    <div class="spacer" />
    <div class="group" data-rail-group="foot">
      <SidebarBell rail />
      <IconButton
        size="lg"
        label="设置"
        side="right"
        @click="settings.openSettings('general')"
      >
        <DsSettings :size="20" />
      </IconButton>
    </div>
  </nav>
</template>

<style scoped>
.app-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  box-sizing: border-box;
  width: var(--rail-w);
  height: 100%;
  padding-bottom: var(--space-3);
  overflow-y: auto;
  scrollbar-width: none;
  background: rgb(var(--sidebar-fill));
}

/* The traffic lights' area: the gutter plus one top bar, empty. */
.rail-top {
  flex: none;
  align-self: stretch;
  height: calc(var(--shell-gutter) + var(--shell-bar-h));
}

.group {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding-top: var(--space-1);
}

.spacer {
  flex: 1;
  min-height: var(--space-3);
}
</style>
