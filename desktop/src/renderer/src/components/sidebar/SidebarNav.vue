<script setup lang="ts">
/**
 * Sidebar nav rows: 新对话 (the trailing + starts a Build project session),
 * then the full pages — Pull Request, 定时任务, 插件, 探索 — highlighted by
 * the current route name.
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DsNewChat, DsPlus } from '../icons/ds'
import {
  activeSidebarPage,
  SIDEBAR_PAGES,
  type SidebarPageEntry,
} from './sidebarNav'

defineProps<{ projectMenuOpen?: boolean }>()
const emit = defineEmits<{
  'new-chat': []
  'new-project': [anchor: HTMLElement]
}>()

const route = useRoute()
const router = useRouter()
const active = computed(() => activeSidebarPage(route.name))
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
    <div class="nav-row new-chat-row">
      <button
        type="button"
        class="nav-item new-session"
        @click="emit('new-chat')"
      >
        <DsNewChat :size="16" class="nav-icon" />
        <span class="nav-label">新对话</span>
      </button>
      <button
        ref="addButton"
        type="button"
        class="nav-add"
        aria-label="新建项目会话"
        title="新建项目会话"
        :aria-expanded="projectMenuOpen"
        @click="newProject"
      >
        <DsPlus :size="14" />
      </button>
    </div>
    <div v-for="entry in SIDEBAR_PAGES" :key="entry.name" class="nav-row">
      <button
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
  gap: var(--space-0-5);
  margin-bottom: var(--space-2);
}

.nav-row {
  display: flex;
  align-items: center;
  height: var(--space-8);
  border-radius: var(--radius-row);
}

.nav-row:hover,
.nav-row:has([aria-expanded='true']) {
  background: var(--interactive-bg-hover);
}

.nav-row:has([aria-current='page']) {
  background: var(--interactive-bg-active);
}

.nav-item {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  height: 100%;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  text-align: left;
  cursor: pointer;
}

.nav-item:focus-visible,
.nav-add:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.nav-item[aria-current='page'] {
  font-weight: 500;
}

.nav-icon {
  flex: none;
  color: rgb(var(--label-secondary));
}

.nav-item[aria-current='page'] .nav-icon {
  color: rgb(var(--label-primary));
}

.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-add {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: var(--space-6);
  height: var(--space-6);
  margin-right: var(--space-1);
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.nav-add:hover,
.nav-add[aria-expanded='true'] {
  background: var(--interactive-bg-hover-strong);
  color: rgb(var(--label-primary));
}
</style>
