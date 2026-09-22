<script setup lang="ts">
/**
 * SearchBlock — dsh grep/glob result surface: summary banner + copy, file
 * groups (collapsible path headers with match counts) or a plain path list,
 * head/tail cap.
 *
 * Props:
 * - kind: 'matches' (uses `files`) | 'paths' (uses `paths`).
 * - files?: SearchFileGroup[]; paths?: string[].
 * - truncated? / total?: backend cap → "显示 n / 共 total".
 * - maxLines (default 16).
 */
import { computed, ref } from 'vue'
import type { SearchFileGroup } from './blockTypes'
import { capRows, DEFAULT_BLOCK_MAX_LINES, headTailCap } from './headTailCap'
import { useCopyFeedback } from './useCopyFeedback'

const props = withDefaults(
  defineProps<{
    kind: 'matches' | 'paths'
    files?: SearchFileGroup[]
    paths?: string[]
    truncated?: boolean
    total?: number
    maxLines?: number
  }>(),
  {
    files: () => [],
    paths: () => [],
    truncated: false,
    total: undefined,
    maxLines: DEFAULT_BLOCK_MAX_LINES,
  },
)

type Row =
  | { type: 'file'; key: string; path: string; count: number; index: number }
  | { type: 'match'; key: string; lineNumber: number; line: string }
  | { type: 'path'; key: string; path: string }

const expanded = ref(false)
const collapsed = ref<Set<number>>(new Set())

const rows = computed<Row[]>(() => {
  if (props.kind === 'paths')
    return props.paths.map((path) => ({ type: 'path', key: `p:${path}`, path }))
  const out: Row[] = []
  props.files.forEach((file, index) => {
    out.push({
      type: 'file',
      key: `f:${index}`,
      path: file.path,
      count: file.matches.length,
      index,
    })
    if (collapsed.value.has(index)) return
    for (const match of file.matches)
      out.push({
        type: 'match',
        key: `m:${index}:${match.lineNumber}`,
        lineNumber: match.lineNumber,
        line: match.line,
      })
  })
  return out
})

const shown = computed(() =>
  props.kind === 'paths'
    ? props.paths.length
    : props.files.reduce((sum, file) => sum + file.matches.length, 0),
)
const summary = computed(() => {
  const count =
    props.truncated && props.total !== undefined
      ? `显示 ${shown.value} / 共 ${props.total}`
      : `${shown.value}`
  return props.kind === 'paths'
    ? `${count} 个路径`
    : `${count} 处匹配 · ${props.files.length} 个文件`
})
const cap = computed(() =>
  headTailCap(rows.value.length, props.maxLines, expanded.value),
)
const display = computed<(Row | { type: 'expand'; key: string })[]>(() => {
  const { head, tail } = capRows(rows.value, cap.value)
  if (cap.value.hidden <= 0) return [...head]
  return [...head, { type: 'expand', key: 'expand' }, ...tail]
})

function toggleFile(index: number) {
  const next = new Set(collapsed.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  collapsed.value = next
}

const { copied, copy } = useCopyFeedback(() =>
  props.kind === 'paths'
    ? props.paths.join('\n')
    : props.files
        .map((file) =>
          [
            file.path,
            ...file.matches.map((m) => `${m.lineNumber}: ${m.line}`),
          ].join('\n'),
        )
        .join('\n\n'),
)
</script>

<template>
  <div class="ds-search" :data-search="kind">
    <div class="header">
      <span class="summary">{{ summary }}</span>
      <button v-if="rows.length" type="button" class="copy" @click="copy">
        {{ copied ? '复制成功' : '复制' }}
      </button>
    </div>
    <div v-if="!rows.length" class="empty">无结果</div>
    <div v-else class="body">
      <template v-for="row in display" :key="row.key">
        <button
          v-if="row.type === 'expand'"
          type="button"
          class="expand"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起' : `… 其余 ${cap.hidden} 行` }}
        </button>
        <button
          v-else-if="row.type === 'file'"
          type="button"
          class="file"
          :aria-expanded="!collapsed.has(row.index)"
          @click="toggleFile(row.index)"
        >
          <span class="file-path" v-text="row.path" />
          <span class="file-count">{{ row.count }}</span>
        </button>
        <div v-else-if="row.type === 'match'" class="line">
          <span class="line-no">{{ row.lineNumber }}: </span
          ><span v-text="row.line" />
        </div>
        <div v-else class="line" v-text="row.path" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.ds-search {
  position: relative;
  color: rgb(var(--label-primary));
  background: rgb(var(--code-block-bg));
  border-radius: var(--radius-card);
}

.header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: calc(var(--space-2) + 1px) var(--space-3-5);
  background: rgb(var(--code-banner-bg));
  border-top-left-radius: var(--radius-card);
  border-top-right-radius: var(--radius-card);
}

.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--font-xs);
  color: rgb(var(--label-secondary));
}

.copy {
  flex: none;
  padding: 0;
  border: none;
  background: transparent;
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  cursor: pointer;
}

.body {
  padding: var(--space-2) var(--space-3-5) var(--space-3) 0;
  font: var(--font-code);
  overflow-x: auto;
  overflow-y: hidden;
}

.line {
  min-height: var(--lh-code);
  padding-left: var(--space-3-5);
  white-space: pre;
}

.line-no,
.file-count {
  color: rgb(var(--label-tertiary));
}

.file {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--lh-code);
  padding: 0 var(--space-3-5);
  border: none;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.file-path {
  min-width: 0;
  font-weight: 600;
  white-space: pre;
  color: rgb(var(--label-primary));
}

.file-count {
  flex: none;
}

.expand {
  display: block;
  width: 100%;
  padding: 0 var(--space-3-5);
  border: none;
  background: transparent;
  color: rgb(var(--label-tertiary));
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.expand:hover {
  color: rgb(var(--label-secondary));
}

.empty {
  padding: var(--space-3) var(--space-3-5);
  font: var(--font-code);
  color: rgb(var(--label-tertiary));
}
</style>
