<script setup lang="ts">
/**
 * PullRequestDiff — the 「查看 diff」 tab: the PR's unified diff split per
 * file, each a collapsible section drawing its hunks with ui/DiffBlock.
 * Small files near the top start expanded; big, generated (lock) and later
 * files start collapsed so a 4 MiB diff does not render all at once. A
 * truncated diff says so. Loaded lazily (DiffBlock + jsdiff).
 *
 * Props: entry (async diff state); focusPath? (scroll to + expand a file,
 * set when a file is picked on the overview tab).
 * Emits: retry, open-external (the truncated notice's GitHub link).
 */
import { computed, nextTick, shallowRef, watch } from 'vue'
import type { PullRequestDiffResult } from '../../../api/pullRequests'
import Button from '../../ui/Button.vue'
import DiffBlock from '../../ui/DiffBlock.vue'
import EmptyState from '../../settings/ui/EmptyState.vue'
import StatusBadge from '../../settings/ui/StatusBadge.vue'
import { pullIcons } from './pullIcons'
import {
  diffFileStartsOpen,
  diffFileStatusLabel,
  splitPullRequestDiff,
  type PullDiffFile,
} from './pullDiff'
import type { AsyncEntry } from './usePullRequestBrowser'

const props = defineProps<{
  entry: AsyncEntry<PullRequestDiffResult>
  focusPath?: string | null
}>()
const emit = defineEmits<{ retry: []; 'open-external': [] }>()

const files = computed<PullDiffFile[]>(() =>
  props.entry.data ? splitPullRequestDiff(props.entry.data.diff) : [],
)
const totals = computed(() =>
  files.value.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  ),
)

const open = shallowRef<ReadonlySet<number>>(new Set())
watch(
  files,
  (list) => {
    open.value = new Set(
      list.flatMap((file, index) =>
        diffFileStartsOpen(file, index) ? [index] : [],
      ),
    )
    void revealFocus()
  },
  { immediate: true },
)

function toggle(index: number): void {
  const next = new Set(open.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  open.value = next
}

const allOpen = computed(
  () =>
    files.value.length > 0 &&
    files.value.every(
      (file, index) => !file.hunks.length || open.value.has(index),
    ),
)
function toggleAll(): void {
  open.value = allOpen.value
    ? new Set()
    : new Set(
        files.value.flatMap((file, index) =>
          file.hunks.length ? [index] : [],
        ),
      )
}

const root = shallowRef<HTMLElement | null>(null)
async function revealFocus(): Promise<void> {
  const path = props.focusPath
  if (!path) return
  const index = files.value.findIndex(
    (file) => file.path === path || file.oldPath === path,
  )
  if (index < 0) return
  if (!open.value.has(index)) open.value = new Set([...open.value, index])
  await nextTick()
  root.value
    ?.querySelector<HTMLElement>(`[data-diff-file="${index}"]`)
    ?.scrollIntoView({ block: 'start' })
}
watch(() => props.focusPath, revealFocus)

function emptyNote(file: PullDiffFile): string {
  if (file.status === 'binary') return '二进制文件，不显示差异。'
  if (file.status === 'renamed') return '文件已重命名，内容没有变化。'
  return '没有可显示的文本差异。'
}
</script>

<template>
  <div ref="root" class="pr-diff">
    <div
      v-if="entry.loading && !entry.data"
      class="diff-loading"
      aria-busy="true"
    >
      正在加载 diff…
    </div>

    <EmptyState
      v-else-if="entry.error && !entry.data"
      variant="plain"
      title="无法加载 diff"
      :description="entry.error.message"
    >
      <Button size="sm" variant="outline" @click="emit('retry')">重试</Button>
    </EmptyState>

    <template v-else-if="entry.data">
      <p v-if="entry.data.truncated" class="truncated" role="note">
        diff 超过 4 MB，只显示了前面的部分。
        <button type="button" class="link" @click="emit('open-external')">
          在 GitHub 查看完整改动
        </button>
      </p>

      <EmptyState
        v-if="!files.length"
        variant="plain"
        title="这个 Pull Request 没有文件改动"
      />

      <template v-else>
        <div class="diff-toolbar">
          <span class="diff-summary">
            {{ files.length }} 个文件
            <span class="add">+{{ totals.additions }}</span>
            <span class="del">−{{ totals.deletions }}</span>
          </span>
          <button type="button" class="link" @click="toggleAll">
            {{ allOpen ? '全部收起' : '全部展开' }}
          </button>
        </div>

        <section
          v-for="(file, index) in files"
          :key="`${index}:${file.path}`"
          class="diff-file"
          :data-diff-file="index"
          :data-open="open.has(index) || undefined"
        >
          <button
            type="button"
            class="file-head"
            :aria-expanded="open.has(index)"
            :disabled="!file.hunks.length"
            @click="toggle(index)"
          >
            <component
              :is="open.has(index) ? pullIcons.collapse : pullIcons.expand"
              :size="14"
              class="chevron"
              aria-hidden="true"
            />
            <span class="file-path" :title="file.path">
              <template v-if="file.oldPath">{{ file.oldPath }} → </template
              >{{ file.path }}
            </span>
            <StatusBadge
              v-if="diffFileStatusLabel(file.status)"
              :tone="file.status === 'deleted' ? 'error' : 'neutral'"
            >
              {{ diffFileStatusLabel(file.status) }}
            </StatusBadge>
            <span class="file-stats">
              <span class="add">+{{ file.additions }}</span>
              <span class="del">−{{ file.deletions }}</span>
            </span>
          </button>
          <div v-if="!file.hunks.length" class="file-note">
            {{ emptyNote(file) }}
          </div>
          <DiffBlock
            v-else-if="open.has(index)"
            class="file-diff"
            :diffs="file.hunks"
            :max-lines="500"
          />
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.pr-diff {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.diff-loading {
  padding: var(--space-6) 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: center;
}

.truncated {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--state-warn-soft));
  color: rgb(var(--state-warn-label));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.diff-summary {
  display: inline-flex;
  gap: var(--space-1-5);
  font-variant-numeric: tabular-nums;
}

.link {
  padding: 0;
  border: none;
  background: transparent;
  color: rgb(var(--label-secondary));
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}

.truncated .link {
  color: inherit;
  text-decoration: underline;
}

.link:hover {
  color: rgb(var(--label-primary));
}

.diff-file {
  min-width: 0;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
}

.file-head {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
  color: rgb(var(--label-primary));
  text-align: left;
  cursor: pointer;
}

.diff-file[data-open] .file-head {
  border-bottom: 1px solid var(--border-l1);
  border-radius: var(--radius-card) var(--radius-card) 0 0;
}

.file-head:disabled {
  cursor: default;
}

.file-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.chevron {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.file-head:disabled .chevron {
  opacity: 0;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font: var(--font-code-small);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-stats {
  display: inline-flex;
  flex: none;
  gap: var(--space-1-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}

.add {
  color: rgb(var(--state-ok-label));
}

.del {
  color: rgb(var(--state-error-label));
}

.file-note {
  padding: 0 var(--space-3) var(--space-2-5)
    calc(var(--space-3) + var(--space-5) + var(--space-0-5));
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

/* The section header already shows path and counts. */
.file-diff :deep(.line--path),
.file-diff :deep(.footer) {
  display: none;
}

.file-diff {
  border-radius: 0 0 var(--radius-card) var(--radius-card);
}
</style>
