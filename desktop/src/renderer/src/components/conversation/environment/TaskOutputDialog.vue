<script setup lang="ts">
/**
 * TaskOutputDialog — read-only 「输出」 of one background job or workflow
 * run (async chunk; EnvironmentCard seats it from its 后台任务 list).
 *
 * Reads `tasks.transcript` a page at a time: a job's output text, or a
 * workflow run's record (phases, logs, agents, outcome). 「加载更多」 while
 * the record has more entries; 「刷新」 reloads from the start while the
 * task is still live. Job output opens scrolled to its latest lines.
 *
 * Props: taskId, label, kind ('job' | 'workflow'), live.
 * Emits: close.
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from 'vue'
import { core } from '../../../api/http'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import {
  transcriptText,
  type TaskTranscriptEntry,
} from '../../workspace/environmentModel'

const PAGE_SIZE = 200

const props = defineProps<{
  taskId: string
  label: string
  kind: 'job' | 'workflow'
  live: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const entries = shallowRef<TaskTranscriptEntry[]>([])
const eof = ref(true)
const loading = ref(false)
const error = ref('')
const output = ref<HTMLElement | null>(null)
let generation = 0

async function load(reset: boolean): Promise<void> {
  const current = ++generation
  loading.value = true
  error.value = ''
  try {
    const page = await core('tasks.transcript', props.taskId, {
      offset: reset ? 0 : entries.value.length,
      limit: PAGE_SIZE,
    })
    if (current !== generation) return
    entries.value = reset ? page.entries : [...entries.value, ...page.entries]
    eof.value = page.eof
    if (reset && props.kind === 'job') {
      await nextTick()
      if (output.value) output.value.scrollTop = output.value.scrollHeight
    }
  } catch (cause) {
    if (current === generation)
      error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === generation) loading.value = false
  }
}

void load(true)
onBeforeUnmount(() => {
  generation += 1
})

const text = computed(() => transcriptText(entries.value))
const title = computed(() =>
  props.kind === 'workflow' ? '工作流记录' : '命令输出',
)
const emptyText = computed(() => {
  if (loading.value) return '正在读取…'
  return props.kind === 'workflow' ? '暂无记录' : '暂无输出'
})

function onOpen(open: boolean): void {
  if (!open) emit('close')
}
</script>

<template>
  <Modal :open="true" :title="title" :width="640" @update:open="onOpen">
    <p class="task-output-label" :title="label">{{ label }}</p>
    <pre
      v-if="text"
      ref="output"
      class="task-output"
      data-task-output
      tabindex="0"
      >{{ text }}</pre>
    <p v-else-if="!error" class="task-output-note">{{ emptyText }}</p>
    <p v-if="error" class="task-output-note" data-tone="error" role="alert">
      {{ error }}
    </p>
    <template v-if="!eof || live" #footer>
      <Button
        v-if="live"
        size="sm"
        variant="ghost"
        :disabled="loading"
        @click="load(true)"
      >
        刷新
      </Button>
      <Button
        v-if="!eof"
        size="sm"
        variant="outline"
        :disabled="loading"
        @click="load(false)"
      >
        加载更多
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.task-output-label {
  margin: 0 0 var(--space-2);
  overflow: hidden;
  color: rgb(var(--label-secondary));
  font: var(--font-code-small);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-output {
  max-height: 60vh;
  margin: 0;
  padding: var(--space-2-5) var(--space-3);
  overflow: auto;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-primary));
  font: var(--font-code-small);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.task-output:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.task-output-note {
  margin: 0;
  padding: var(--space-2) 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.task-output-note[data-tone='error'] {
  color: rgb(var(--state-error-label));
}
</style>
