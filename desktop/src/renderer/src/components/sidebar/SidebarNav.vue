<script setup lang="ts">
/**
 * Sidebar nav (UI-S11): the 新对话 primary row — a raised, hairline-edged
 * 36px button that shows ⌘N on hover, with the + beside it starting a Build
 * project session — then the full pages one step quieter: Pull Request
 * (while the GitHub plugin is on), 定时任务, 能力, highlighted by the
 * current route name.
 */
import { elementOf } from '../ui/elementOf'
import IconButton from '../ui/IconButton.vue'
import Kbd from '../ui/Kbd.vue'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppContext } from '../../composables/useAppContext'
import { detectShortcutPlatform, shortcutLabel } from '../../shortcuts'
import { DsNewChat, DsPlus } from '../icons/ds'
import {
  activeSidebarPage,
  visibleSidebarPages,
  type SidebarPageEntry,
} from './sidebarNav'

defineProps<{ projectMenuOpen?: boolean }>()
const emit = defineEmits<{
  'new-chat': []
  'new-project': [anchor: HTMLElement]
}>()

const ctx = useAppContext()
const route = useRoute()
const router = useRouter()
const active = computed(() => activeSidebarPage(route.name))
const pages = computed(() => visibleSidebarPages(ctx.boot.value?.plugins ?? []))
const newChatShortcut = shortcutLabel('session.new', detectShortcutPlatform())
const addButton = ref<HTMLElement | null>(null)

function go(entry: SidebarPageEntry): void {
  void router.push(entry.to).catch(() => undefined)
}

function newProject(): void {
  if (addButton.value) emit('new-project', addButton.value)
}
</script>

<template>
  <nav class="sidebar-nav" aria-label="侧栏导航">
    <div class="new-chat-row" data-sidebar-block="new">
      <button
        type="button"
        class="new-chat"
        aria-label="新对话"
        @click="emit('new-chat')"
      >
        <DsNewChat :size="16" class="new-chat-icon" />
        <span class="new-chat-label">新对话</span>
        <Kbd v-if="newChatShortcut" class="new-chat-key">{{
          newChatShortcut
        }}</Kbd>
      </button>
      <IconButton
        :ref="(c) => (addButton = elementOf(c))"
        class="nav-add"
        label="新建项目会话"
        size="sm"
        :aria-expanded="projectMenuOpen"
        @click="newProject"
      >
        <DsPlus :size="16" />
      </IconButton>
    </div>
    <div class="pages" data-sidebar-block="pages">
      <button
        v-for="entry in pages"
        :key="entry.name"
        type="button"
        class="nav-item"
        :aria-current="active === entry.name ? 'page' : undefined"
        @click="go(entry)"
      >
        <component :is="entry.icon" :size="16" class="nav-icon" />
        <span class="nav-label">{{ entry.label }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.sidebar-nav {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

/* 新对话: the one raised object in the sidebar. */
.new-chat-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.new-chat {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: 36px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: var(--elev-1);
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: box-shadow var(--motion-base) var(--ease-standard);
}

.new-chat:hover {
  box-shadow: var(--elev-2);
}

.new-chat:focus-visible,
.nav-item:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.new-chat-icon {
  flex: none;
  color: rgb(var(--text-2));
}

.new-chat-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new-chat-key {
  flex: none;
  font-size: var(--fs-xxs);
  font-weight: 400;
  color: rgb(var(--text-3));
  opacity: 0;
  transition: opacity var(--motion-base) var(--ease-standard);
}

.new-chat:hover .new-chat-key,
.new-chat:focus-visible .new-chat-key {
  opacity: 1;
}

.nav-add {
  flex: none;
  color: rgb(var(--text-3));
}

/* The full pages, one step quieter than the sessions below. */
.pages {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: var(--space-8);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--text-2));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  text-align: left;
  cursor: pointer;
}

.nav-item:hover {
  background: var(--surface-hover);
  color: rgb(var(--text-1));
}

.nav-item[aria-current='page'] {
  background: rgb(var(--surface-selected));
  color: rgb(var(--text-1));
  font-weight: 500;
}

.nav-icon {
  flex: none;
  color: rgb(var(--text-3));
}

.nav-item:hover .nav-icon,
.nav-item[aria-current='page'] .nav-icon {
  color: rgb(var(--text-1));
}

.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
