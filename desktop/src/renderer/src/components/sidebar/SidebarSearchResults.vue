<script setup lang="ts">
/**
 * Conversation search results (replaces the session list while the search
 * capsule has a query). ↑ / ↓ / Enter are handled by the capsule input; a
 * mousedown here never steals its focus.
 */
import type { SidebarSearchResult } from '../../runtime/sidebarModel'

defineProps<{ results: SidebarSearchResult[]; selectedIndex: number }>()
const emit = defineEmits<{ hover: [index: number]; open: [id: string] }>()
</script>

<template>
  <div class="list" role="listbox" aria-label="搜索结果">
    <button
      v-for="(result, index) in results"
      :key="result.id"
      type="button"
      class="search-result"
      :data-selected="index === selectedIndex || undefined"
      @mouseenter="emit('hover', index)"
      @mousedown.prevent
      @click="emit('open', result.id)"
    >
      <span class="search-title">{{ result.title }}</span>
      <span class="search-meta">{{ result.subtitle }}</span>
    </button>
    <div v-if="!results.length" class="empty">没有匹配的会话</div>
  </div>
</template>

<style scoped>
.list {
  flex: 1;
  min-height: 0;
  padding-right: var(--space-2);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.search-result {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  box-sizing: border-box;
  width: 100%;
  min-height: 48px;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-primary));
  text-align: left;
  cursor: pointer;
}

.search-result:hover,
.search-result[data-selected] {
  background: var(--interactive-bg-hover);
}

.search-title,
.search-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-title {
  font-size: var(--fs-s);
  line-height: var(--space-5);
}

.search-meta {
  font-size: var(--fs-xxs);
  line-height: 17px;
  color: rgb(var(--label-tertiary));
}

.empty {
  padding: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-caption));
}
</style>
