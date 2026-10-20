<script setup lang="ts">
/**
 * DelegationDiffDialog — 查看差异 on a subagent's result card (AGT-06): the
 * files on the left, the chosen file's diff on the right
 * (`delegations.diff`: the result against its base, or what applying it
 * changed in the project). Read-only. Loaded only when opened.
 *
 * Props: runId, sessionId (the owning conversation), source (Codex /
 * Claude Code), files, path ('' = the first file). Emits: close.
 */
import { computed, ref, watch } from 'vue'
import type { TurnFileEntry } from '@emperor/core/runtime-contract'
import { delegationResultDiff } from '../../../api/delegations'
import { splitPullRequestDiff } from '../../pages/pulls/pullDiff'
import Badge from '../../ui/Badge.vue'
import DiffBlock from '../../ui/DiffBlock.vue'
import Modal from '../../ui/Modal.vue'
import { fileCounts, fileStatusTag, splitFilePath } from './turnFilesModel'

const props = defineProps<{
  runId: string
  sessionId: string
  source: string
  files: readonly TurnFileEntry[]
  path: string
}>()
const emit = defineEmits<{ close: [] }>()

const selected = ref(props.path || props.files[0]?.path || '')
const diff = ref('')
const truncated = ref(false)
const loading = ref(false)
const error = ref('')
let generation = 0

const file = computed(() =>
  props.files.find((entry) => entry.path === selected.value),
)
const hunks = computed(() => splitPullRequestDiff(diff.value)[0]?.hunks ?? [])
const note = computed(() => {
  if (!file.value) return ''
  const counts = fileCounts(file.value)
  return 'note' in counts ? counts.note : ''
})

watch(selected, () => void load(), { immediate: true })

async function load(): Promise<void> {
  const current = ++generation
  diff.value = ''
  truncated.value = false
  error.value = ''
  if (!file.value || note.value) return
  loading.value = true
  try {
    const result = await delegationResultDiff({
      runId: props.runId,
      sessionId: props.sessionId,
      path: file.value.path,
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

function counts(entry: TurnFileEntry): {
  additions: string
  deletions: string
} {
  const value = fileCounts(entry)
  return 'note' in value ? { additions: '', deletions: '' } : value
}
</script>

<template>
  <Modal
    :open="true"
    :title="`${source} 的改动`"
    :width="880"
    @update:open="!$event && emit('close')"
  >
    <div class="result-diff" data-delegation-diff>
      <ul class="files" role="listbox" :aria-label="`${source} 改动的文件`">
        <li v-for="entry in files" :key="entry.path">
          <button
            type="button"
            class="file"
            role="option"
            :aria-selected="entry.path === selected"
            :data-active="entry.path === selected || undefined"
            :title="entry.path"
            @click="selected = entry.path"
          >
            <span class="path">
              <span class="dir">{{ splitFilePath(entry.path).dir }}</span>
              <span class="name">{{ splitFilePath(entry.path).name }}</span>
            </span>
            <Badge v-if="fileStatusTag(entry)">{{
              fileStatusTag(entry)
            }}</Badge>
            <span class="counts">
              <span class="add">{{ counts(entry).additions }}</span>
              <span class="del">{{ counts(entry).deletions }}</span>
            </span>
          </button>
        </li>
      </ul>
      <div class="diff" aria-live="polite">
        <p v-if="note" class="muted">{{ note }}，没有可显示的差异。</p>
        <p v-else-if="loading" class="muted">正在读取差异…</p>
        <p v-else-if="error" class="error" role="alert">{{ error }}</p>
        <template v-else-if="hunks.length">
          <DiffBlock :diffs="hunks" :max-lines="400" />
          <p v-if="truncated" class="muted">差异过长，只显示开头部分。</p>
        </template>
        <p v-else-if="file" class="muted">这个文件只有重命名，内容没有变化。</p>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.result-diff {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
  gap: var(--space-3);
  height: min(60vh, 560px);
  min-height: 0;
  font: var(--type-caption) var(--font-sans);
}

.files {
  margin: 0;
  padding: var(--space-1);
  overflow-y: auto;
  border-radius: var(--r-md);
  background: rgb(var(--surface-sunken));
  list-style: none;
}

.file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--control-sm);
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: rgb(var(--text-1));
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.file:hover {
  background: var(--surface-hover);
}

.file[data-active] {
  background: rgb(var(--surface-selected));
}

.file:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.path {
  display: flex;
  flex: 1;
  min-width: 0;
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

.counts {
  display: inline-flex;
  flex: none;
  gap: var(--space-1);
  font-variant-numeric: tabular-nums;
}

.add {
  color: rgb(var(--ok));
}

.del {
  color: rgb(var(--error));
}

.diff {
  min-width: 0;
  overflow: auto;
}

.muted {
  margin: var(--space-2) 0;
  color: rgb(var(--text-3));
}

.error {
  margin: var(--space-2) 0;
  color: rgb(var(--error));
  overflow-wrap: anywhere;
}
</style>
