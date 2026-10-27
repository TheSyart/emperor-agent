<script setup lang="ts">
/**
 * Search results (replace the session list while the search box has a
 * query), by mode (MOD-04, docs/design/modes.md § 侧栏): the current
 * mode's results under its name (「Build」), then every other mode's under
 * 「其他模式」. Each row carries its mode as a small tag (Chat / Build /
 * Group); in each section title matches come first, then the sessions
 * found by what was said in them (a snippet each), once Core answers.
 * ↑ / ↓ / Enter are handled by the search input over one running index; a
 * mousedown here never steals its focus.
 */
import { computed } from 'vue'
import type { AppMode } from '../../runtime/appMode'
import type { SearchSection } from '../../runtime/sidebarModel'
import Badge from '../ui/Badge.vue'
import { modeEntry } from './modeEntries'

const props = defineProps<{
  sections: SearchSection[]
  selectedIndex: number
  /** Content search still running (an empty list says so). */
  pending?: boolean
}>()
const emit = defineEmits<{ hover: [index: number]; open: [id: string] }>()

/** Each section with its heading and its rows' running indexes. */
const blocks = computed(() => {
  let index = 0
  return props.sections.map((section) => ({
    key: section.key,
    label:
      section.key === 'current' && section.mode
        ? modeEntry(section.mode).name
        : '其他模式',
    rows: section.results.map((result) => ({ result, index: index++ })),
  }))
})
const empty = computed(() => blocks.value.every((block) => !block.rows.length))

function modeName(mode: AppMode | null): string {
  return mode ? modeEntry(mode).name : ''
}
</script>

<template>
  <div class="list" role="listbox" aria-label="搜索结果">
    <template v-for="block in blocks" :key="block.key">
      <div
        class="group-label"
        role="presentation"
        :data-search-section="block.key"
      >
        {{ block.label }}
      </div>
      <button
        v-for="{ result, index } in block.rows"
        :key="result.id"
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
        <span class="search-line">
          <span class="search-title">{{ result.title }}</span>
          <Badge
            v-if="result.mode"
            class="search-mode"
            data-mode-tag
            :label="modeName(result.mode)"
          />
        </span>
        <span class="search-meta">{{ result.subtitle }}</span>
      </button>
    </template>
    <div v-if="empty" class="empty">
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
  color: rgb(var(--text-1));
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
  font-weight: var(--weight-medium);
  color: rgb(var(--text-3));
}

.search-line {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.search-title,
.search-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-title {
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--space-5);
}

.search-mode {
  flex: none;
  margin-left: auto;
}

.search-meta {
  font-size: var(--fs-xxs);
  line-height: 17px;
  color: rgb(var(--text-3));
}

.empty {
  padding: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
}
</style>
