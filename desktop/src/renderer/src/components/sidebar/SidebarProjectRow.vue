<script setup lang="ts">
/**
 * One project folder row of the 项目 section (34px): folder glyph (a
 * chevron on hover), name, session count, and a hover 新建该项目会话 button.
 * Clicking the row folds / unfolds its sessions.
 */
import type { SidebarProjectGroup } from '../../runtime/sidebarModel'
import {
  DsChevronRight,
  DsFolderClose,
  DsFolderOpen,
  DsNewChat,
} from '../icons/ds'

defineProps<{ project: SidebarProjectGroup; collapsed: boolean }>()
const emit = defineEmits<{ toggle: []; 'new-session': [] }>()
</script>

<template>
  <div
    class="project-row"
    role="button"
    tabindex="0"
    :title="project.path"
    :aria-expanded="!collapsed"
    @click="emit('toggle')"
    @keydown.enter.self="emit('toggle')"
  >
    <span class="slot">
      <DsChevronRight
        :size="14"
        class="chevron"
        :data-open="!collapsed || undefined"
      />
      <component
        :is="collapsed ? DsFolderClose : DsFolderOpen"
        :size="16"
        class="folder"
      />
    </span>
    <span class="project-name">{{ project.name }}</span>
    <span class="project-count">{{ project.sessions.length }}</span>
    <button
      type="button"
      class="row-action"
      aria-label="新建该项目会话"
      title="新建该项目会话"
      @click.stop="emit('new-session')"
    >
      <DsNewChat :size="14" />
    </button>
  </div>
</template>

<style scoped>
.project-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  box-sizing: border-box;
  height: 34px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-primary));
  cursor: pointer;
  user-select: none;
  outline: none;
}

.project-row:hover {
  background: var(--interactive-bg-hover);
}

.project-row:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.slot {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-5);
  color: rgb(var(--label-tertiary));
}

.slot .chevron {
  display: none;
  color: rgb(var(--label-caption));
  transition: transform var(--duration-ds) var(--ease-in-out);
}

.slot .chevron[data-open] {
  transform: rotate(90deg);
}

.project-row:hover .chevron {
  display: inline-flex;
}

.project-row:hover .folder {
  display: none;
}

.project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--space-5);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-count {
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--space-5);
  color: rgb(var(--label-tertiary));
}

.row-action {
  display: none;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-5);
  height: var(--space-5);
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.row-action:hover {
  color: rgb(var(--label-primary));
}

.project-row:hover .row-action,
.project-row:focus-within .row-action {
  display: inline-flex;
}

.project-row:hover .project-count {
  display: none;
}
</style>
