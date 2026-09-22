<script setup lang="ts">
/**
 * TodoDock — dsh todo panel above the composer card (radius 12, tip fill,
 * 36px collapsed row): checklist glyph, progress summary with the current
 * in-progress item, expandable item list with status glyphs.
 */
import { computed, ref } from 'vue'
import type { TodoItem } from '../../types'
import { DsCheck, DsChecklist, DsChevronDown, DsLoading } from '../icons/ds'

const props = defineProps<{ todos: TodoItem[] }>()

const expanded = ref(false)
const done = computed(
  () => props.todos.filter((item) => item.status === 'completed').length,
)
const current = computed(
  () => props.todos.find((item) => item.status === 'in_progress') ?? null,
)
const summary = computed(() => {
  const head = `${done.value}/${props.todos.length}`
  return current.value ? `${head} · ${current.value.content}` : head
})
</script>

<template>
  <section v-if="todos.length" class="todo-dock" aria-label="待办进度">
    <div class="body">
      <button
        type="button"
        class="header"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <DsChecklist :size="14" class="lead" aria-hidden="true" />
        <span class="title">待办</span>
        <span class="progress" :title="summary">{{ summary }}</span>
        <DsChevronDown
          :size="14"
          class="chevron"
          :data-open="expanded || undefined"
          aria-hidden="true"
        />
      </button>
      <ul v-if="expanded" class="list">
        <li
          v-for="item in todos"
          :key="String(item.id)"
          class="item"
          :data-status="item.status"
        >
          <span class="glyph" aria-hidden="true">
            <DsCheck v-if="item.status === 'completed'" :size="14" />
            <DsLoading
              v-else-if="item.status === 'in_progress'"
              :size="14"
              class="spin"
            />
            <span v-else class="ring" />
          </span>
          <span class="content" :title="item.content">{{ item.content }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.todo-dock {
  box-sizing: border-box;
  flex: none;
  width: calc(100% - 2 * var(--composer-clearance) - 4 * var(--dock-inset));
  max-width: calc(var(--composer-card-max) - 4 * var(--dock-inset));
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--tip-fill));
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-3);
}

.header {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.lead,
.chevron {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.chevron {
  transition: transform var(--duration-ds-fast) ease;
}

.chevron[data-open] {
  transform: rotate(180deg);
}

.title {
  flex: none;
  font-size: var(--fs-xs);
  line-height: var(--space-6);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.progress {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 180px;
  margin: 0;
  padding: 0 0 var(--space-1);
  overflow-y: auto;
  list-style: none;
}

.item {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.item[data-status='completed'] .content {
  color: rgb(var(--label-tertiary));
  text-decoration: line-through;
}

.glyph {
  display: grid;
  flex: none;
  place-items: center;
  width: var(--space-4);
  height: var(--space-4);
  color: rgb(var(--label-caption));
}

.item[data-status='completed'] .glyph {
  color: rgb(var(--ok));
}

.item[data-status='in_progress'] .glyph {
  color: rgb(var(--accent-fill));
}

.ring {
  box-sizing: border-box;
  width: var(--space-3);
  height: var(--space-3);
  border: 1.5px solid currentColor;
  border-radius: var(--radius-pill);
}

.spin {
  animation: todo-spin 1s linear infinite;
}

@keyframes todo-spin {
  to {
    transform: rotate(360deg);
  }
}

.content {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
