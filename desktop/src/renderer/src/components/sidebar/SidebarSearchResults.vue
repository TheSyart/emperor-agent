<script setup lang="ts">
/**
 * Search results (replace the session list while the search box has a
 * query): 「会话」 — title, project and path matches at once — then 「内容」,
 * the sessions found by what was said in them (a snippet each), once Core
 * answers. ↑ / ↓ / Enter are handled by the search input; a mousedown here
 * never steals its focus.
 */
import { computed } from 'vue'
import type { SidebarSearchResult } from '../../runtime/sidebarModel'

const props = defineProps<{
  results: SidebarSearchResult[]
  selectedIndex: number
  /** Content search still running (an empty list says so). */
  pending?: boolean
}>()
const emit = defineEmits<{ hover: [index: number]; open: [id: string] }>()

const firstContent = computed(() =>
  props.results.findIndex((result) => result.group === 'content'),
)
</script>

<template>
  <div class="list" role="listbox" aria-label="搜索结果">
    <div v-if="firstContent > 0" class="group-label" role="presentation">
      会话
    </div>
    <template v-for="(result, index) in results" :key="result.id">
      <div
        v-if="index === firstContent"
        class="group-label"
        role="presentation"
      >
        内容
      </div>
      <button
        type="button"
        class="search-result"
        role="option"
        :data-search-result="result.id"
        :data-selected="index === selectedIndex || undefined"
        :aria-selected="index === selectedIndex"
        @mouseenter="emit('hover', index)"
        @mousedown.prevent
        @click="emit('open', result.id)"
      >
        <span class="search-title">{{ result.title }}</span>
        <span class="search-meta">{{ result.subtitle }}</span>
      </button>
    </template>
    <div v-if="!results.length" class="empty">
      {{ pending ? '正在搜索内容…' : '没有匹配的会话' }}
    </div>
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
  background: var(--surface-hover);
}

.group-label {
  padding: var(--space-2) var(--space-2) var(--space-1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-tertiary));
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
