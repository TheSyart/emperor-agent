<script setup lang="ts">
/**
 * TurnReviewView — the 审查 pane's 本轮改动 mode (plan 7.6): the files one
 * recorded turn changed and, for the chosen file, the diff between the
 * turn's two snapshots (`workspace.turnDiff`). Read-only; 返回 goes back to
 * the working-tree review. Opened from the 「已编辑 N 个文件」 card.
 *
 * Props: request (TurnReviewRequest). Emits: close.
 */
import Badge from '../ui/Badge.vue'
import { ArrowLeft } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import type { TurnFileEntry } from '@emperor/core/runtime-contract'
import { core } from '../../api/http'
import {
  fileCounts,
  fileStatusTag,
  splitFilePath,
} from '../conversation/nodes/turnFilesModel'
import { splitPullRequestDiff } from '../pages/pulls/pullDiff'
import DiffBlock from '../ui/DiffBlock.vue'
import IconButton from '../ui/IconButton.vue'
import type { TurnReviewRequest } from './workspaceState'

const props = defineProps<{ request: TurnReviewRequest }>()
const emit = defineEmits<{ close: [] }>()

const selected = ref('')
const diff = ref('')
const truncated = ref(false)
const loading = ref(false)
const error = ref('')
let generation = 0

const totals = computed(() =>
  props.request.files.reduce(
    (sum, file) => ({
      additions: sum.additions + (file.additions ?? 0),
      deletions: sum.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  ),
)
const file = computed(() =>
  props.request.files.find((entry) => entry.path === selected.value),
)
const hunks = computed(() => splitPullRequestDiff(diff.value)[0]?.hunks ?? [])

watch(
  () => props.request,
  (request) => {
    selected.value = request.path ?? request.files[0]?.path ?? ''
  },
  { immediate: true },
)
watch([selected, () => props.request], () => void load(), { immediate: true })

async function load(): Promise<void> {
  const current = ++generation
  diff.value = ''
  truncated.value = false
  error.value = ''
  const entry = file.value
  if (entry === undefined || entry.tooLarge || entry.binary) return
  loading.value = true
  try {
    const result = await core('workspace.turnDiff', {
      sessionId: props.request.sessionId,
      turn: props.request.turn,
      path: entry.path,
    })
    if (current !== generation) return
    diff.value = result.diff
    truncated.value = result.truncated
  } catch (cause) {
    if (current === generation)
      error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === generation) loading.value = false
  }
}

function lineCounts(entry: TurnFileEntry): {
  additions: string
  deletions: string
} {
  const counts = fileCounts(entry)
  return 'note' in counts ? { additions: '', deletions: '' } : counts
}

function noteOf(entry: TurnFileEntry): string {
  const counts = fileCounts(entry)
  return 'note' in counts ? counts.note : ''
}
</script>

<template>
  <section
    class="turn-review"
    aria-label="本轮改动"
    :data-turn-review="request.turn"
  >
    <header class="head">
      <IconButton label="返回审查" @click="emit('close')">
        <ArrowLeft :size="14" />
      </IconButton>
      <div class="title">
        <strong>本轮改动</strong>
        <span class="summary">
          {{ request.files.length }} 个文件
          <span class="add">+{{ totals.additions }}</span>
          <span class="del">−{{ totals.deletions }}</span>
        </span>
      </div>
    </header>
    <ul class="files" role="listbox" aria-label="本轮改动的文件">
      <li v-for="entry in request.files" :key="entry.path">
        <button
          type="button"
          class="file"
          role="option"
          :aria-selected="entry.path === selected"
          :class="{ active: entry.path === selected }"
          :title="entry.path"
          @click="selected = entry.path"
        >
          <span class="path">
            <span class="dir">{{ splitFilePath(entry.path).dir }}</span>
            <span class="name">{{ splitFilePath(entry.path).name }}</span>
          </span>
          <Badge v-if="fileStatusTag(entry)">{{ fileStatusTag(entry) }}</Badge>
          <span v-if="noteOf(entry)" class="note">{{ noteOf(entry) }}</span>
          <span v-else class="counts">
            <span class="add">{{ lineCounts(entry).additions }}</span>
            <span class="del">{{ lineCounts(entry).deletions }}</span>
          </span>
        </button>
      </li>
    </ul>
    <div class="diff" aria-live="polite">
      <p v-if="file && noteOf(file)" class="muted">
        {{ noteOf(file) }}，没有可显示的差异。
      </p>
      <p v-else-if="loading" class="muted">正在读取差异…</p>
      <p v-else-if="error" class="error" role="alert">{{ error }}</p>
      <template v-else-if="hunks.length">
        <DiffBlock :diffs="hunks" :max-lines="400" />
        <p v-if="truncated" class="muted">差异过长，只显示开头部分。</p>
      </template>
      <p v-else-if="file" class="muted">这个文件只有重命名，内容没有变化。</p>
    </div>
  </section>
</template>

<style scoped>
.turn-review {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--stroke-2);
}

.title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.summary {
  display: inline-flex;
  gap: var(--space-1);
  color: rgb(var(--text-2));
  font-variant-numeric: tabular-nums;
}

.add {
  color: rgb(var(--ok));
}

.del {
  color: rgb(var(--error));
}

.files {
  flex: none;
  max-height: 40%;
  margin: 0;
  padding: var(--space-1) 0;
  overflow-y: auto;
  list-style: none;
  border-bottom: 1px solid var(--stroke-2);
}

.file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-3);
  border: 0;
  background: transparent;
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: start;
  cursor: pointer;
}

.file:hover,
.file.active {
  background: var(--surface-hover);
}

.path {
  display: flex;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
}

.dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(var(--text-3));
}

.name {
  flex: none;
}

.note {
  flex: none;
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
}

.counts {
  display: inline-flex;
  flex: none;
  gap: var(--space-1);
  font-variant-numeric: tabular-nums;
}

.diff {
  flex: 1;
  min-height: 0;
  padding: var(--space-3);
  overflow: auto;
}

.muted {
  margin: 0;
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
}

.error {
  margin: 0;
  color: rgb(var(--error));
  font-size: var(--fs-xs);
}
</style>
