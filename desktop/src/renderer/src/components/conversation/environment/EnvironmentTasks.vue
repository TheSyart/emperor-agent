<script setup lang="ts">
/**
 * 后台任务 on the environment card (UI-S05): background jobs and workflow
 * runs from `tasks.list`, shown only when there are any. One summary row
 * (「2 个运行中」) lists them in place, live first; each line is one button
 * that opens its 输出 (TaskOutputDialog), where 「停止」 lives.
 *
 * The list reloads shortly after the transcript grows or a turn settles,
 * and every 5 s while something runs and the window has focus; a cached
 * (deactivated) card stops polling.
 *
 * Props: sessionId, snapshot (the viewed chat window), active (the card is
 * shown, not cached).
 */
import { Workflow } from 'lucide-vue-next'
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { core } from '../../../api/http'
import type { ChatSnapshot } from '../../../conversation/types'
import type { RuntimeTaskRecord } from '../../../types'
import Dot from '../../ui/Dot.vue'
import {
  backgroundTaskDot,
  backgroundTaskLines,
  backgroundTaskSummary,
  backgroundTaskTime,
  isLiveTaskStatus,
  type BackgroundTaskLine,
} from '../../workspace/environmentModel'
import EnvironmentRow from './EnvironmentRow.vue'

const VISIBLE_ROWS = 3
const TaskOutputDialog = defineAsyncComponent(
  () => import('./TaskOutputDialog.vue'),
)

const props = defineProps<{
  sessionId: string
  snapshot: ChatSnapshot
  active: boolean
}>()

const tasks = shallowRef<RuntimeTaskRecord[]>([])
const open = ref(false)
const showAll = ref(false)
/** The task whose 输出 is open. */
const outputId = ref<string | null>(null)
let generation = 0
let reloadTimer: ReturnType<typeof setTimeout> | undefined
let poll: ReturnType<typeof setInterval> | undefined

async function load(): Promise<void> {
  const owner = props.sessionId
  const current = ++generation
  try {
    const list: unknown = await core('tasks.list', { sessionId: owner })
    if (current === generation)
      tasks.value = Array.isArray(list) ? (list as RuntimeTaskRecord[]) : []
  } catch {
    // The card stays usable when the task list is unavailable.
    if (current === generation) tasks.value = []
  }
}

watch(
  () => props.sessionId,
  () => {
    tasks.value = []
    open.value = false
    showAll.value = false
    outputId.value = null
    void load()
  },
  { immediate: true },
)
// New transcript rows or a settled turn may start or finish a task.
watch(
  () => [props.snapshot.order.length, props.snapshot.running] as const,
  () => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => void load(), 400)
  },
)
watch(
  () => props.active && tasks.value.some((t) => isLiveTaskStatus(t.status)),
  (running) => {
    clearInterval(poll)
    poll = running
      ? setInterval(() => {
          if (document.hasFocus()) void load()
        }, 5_000)
      : undefined
  },
  { immediate: true },
)

const summary = computed(() => backgroundTaskSummary(tasks.value))
const value = computed(() =>
  summary.value.running
    ? `${summary.value.running} 个运行中`
    : `${summary.value.total} 个已结束`,
)
const lines = computed(() => backgroundTaskLines(tasks.value))
// Live ones are always shown.
const shown = computed(() => Math.max(VISIBLE_ROWS, summary.value.running))
const visible = computed(() =>
  showAll.value ? lines.value : lines.value.slice(0, shown.value),
)
const hidden = computed(() => Math.max(0, lines.value.length - shown.value))
const outputLine = computed(
  () => lines.value.find((line) => line.id === outputId.value) ?? null,
)

/** Elapsed times tick while the list is open and something runs. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
watch(
  () => props.active && open.value && summary.value.running > 0,
  (ticking) => {
    clearInterval(clock)
    now.value = Date.now()
    clock = ticking
      ? setInterval(() => {
          now.value = Date.now()
        }, 1_000)
      : undefined
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  generation += 1
  clearTimeout(reloadTimer)
  clearInterval(poll)
  clearInterval(clock)
})

function meta(line: BackgroundTaskLine): string {
  const time = backgroundTaskTime(
    {
      status: line.status,
      started_at: line.startedAt,
      finished_at: line.finishedAt,
    },
    now.value,
  )
  return [line.detail, time].filter(Boolean).join(' · ')
}

function title(line: BackgroundTaskLine): string {
  return [line.label, line.statusLabel, line.error].filter(Boolean).join('\n')
}
</script>

<template>
  <div v-if="summary.total" class="tasks">
    <EnvironmentRow
      data-row="background"
      label="后台任务"
      :value="value"
      :status="summary.running ? 'running' : undefined"
      :expanded="open"
      aria-controls="env-card-background"
      @click="open = !open"
    >
      <template #lead><Workflow :size="15" /></template>
    </EnvironmentRow>
    <ul
      v-if="open"
      id="env-card-background"
      class="task-list"
      aria-label="后台任务"
    >
      <li v-for="line in visible" :key="line.id">
        <button
          type="button"
          class="task-line"
          :data-task-id="line.id"
          :data-kind="line.kind"
          :title="title(line)"
          :aria-label="`查看输出：${line.label} · ${line.statusLabel}`"
          @click="outputId = line.id"
        >
          <Dot
            class="task-dot"
            size="sm"
            :data-status="line.tone"
            :state="backgroundTaskDot(line.tone)"
          />
          <span class="task-label" :class="{ mono: line.kind === 'job' }">{{
            line.label
          }}</span>
          <span class="task-meta">{{ meta(line) }}</span>
        </button>
      </li>
      <li v-if="hidden">
        <button
          type="button"
          class="task-more"
          :aria-expanded="showAll"
          @click="showAll = !showAll"
        >
          {{ showAll ? '收起' : `再显示 ${hidden} 个` }}
        </button>
      </li>
    </ul>
    <TaskOutputDialog
      v-if="outputLine"
      :key="outputLine.id"
      :task-id="outputLine.id"
      :label="outputLine.label"
      :kind="outputLine.kind"
      :live="outputLine.live"
      :stoppable="outputLine.stoppable"
      :confirm-stop="outputLine.confirmStop"
      @stopped="load"
      @close="outputId = null"
    />
  </div>
</template>

<style scoped>
.tasks {
  display: flex;
  flex-direction: column;
}

.task-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: var(--space-0-5) 0 var(--space-1) var(--space-6);
  list-style: none;
}

.task-line {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  column-gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: rgb(var(--text-1));
  text-align: left;
  cursor: pointer;
}

.task-line:hover {
  background: var(--surface-hover);
}

.task-line:focus-visible,
.task-more:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.task-label {
  overflow: hidden;
  font: var(--font-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-label.mono {
  font: var(--font-code-small);
}

.task-meta {
  grid-column: 2;
  overflow: hidden;
  color: rgb(var(--text-3));
  font: var(--font-xxs);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-more {
  padding: var(--space-1) var(--space-2);
  border: none;
  background: transparent;
  color: rgb(var(--text-3));
  font: var(--font-xxs);
  cursor: pointer;
}

.task-more:hover {
  color: rgb(var(--text-1));
}
</style>
