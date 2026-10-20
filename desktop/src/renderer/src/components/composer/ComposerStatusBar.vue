<script setup lang="ts">
/**
 * ComposerStatusBar — one line above the composer card (UI-S04) in place
 * of the four docks: 「3 个文件已更改 +18 −4 · 待办 2/4 · 目标进行中 ·
 * 1 条待发送 ›」 (statusBarModel.ts). Nothing renders when no part has
 * anything to say. The line is one button; it opens a ui/Popover the width
 * of the bar with a section per part: 改动 (审查 opens the review pane),
 * 待办, 目标 (pause / resume, edit, clear) and the queue (send / edit /
 * discard a held message, interject / edit / delete a queued one).
 *
 * The change total is the Build session's git summary from the shared
 * workspace snapshot (a workspace total, not one turn's ledger). While a
 * takeover card holds the composer seat only the goal stays.
 *
 * Props: sessionId (the viewed session), build (a Build session bound to a
 * project — only then is the snapshot polled), todos, goal, goalActionPending,
 * queue, takeover?.
 * Emits: goal-action(pause | resume | cancel), goal-edit, and edit /
 * interject / cancel / send for a queued message.
 */
import { computed, nextTick, onActivated, onDeactivated, ref } from 'vue'
import type { QueuedPromptItem, RuntimeGoalView, TodoItem } from '../../types'
import type { GoalCardAction } from '../../runtime/goalRender'
import { DsCheck, DsChevronRight } from '../icons/ds'
import LinkButton from '../ui/LinkButton.vue'
import Popover from '../ui/Popover.vue'
import Spinner from '../ui/Spinner.vue'
import { useWorkspaceSnapshot } from '../workspace/useWorkspaceSnapshot'
import { requestWorkspace } from '../workspace/workspaceState'
import { isGitStatus } from '../workspace/workspaceTypes'
import StatusGoalSection from './StatusGoalSection.vue'
import StatusQueueSection from './StatusQueueSection.vue'
import { statusParts, todoProgress, type StatusChanges } from './statusBarModel'

const props = defineProps<{
  sessionId: string
  build: boolean
  todos: TodoItem[]
  goal: RuntimeGoalView | null
  goalActionPending?: GoalCardAction | null
  queue: QueuedPromptItem[]
  takeover?: boolean
}>()

const emit = defineEmits<{
  'goal-action': [action: GoalCardAction]
  'goal-edit': []
  edit: [item: QueuedPromptItem]
  interject: [item: QueuedPromptItem]
  cancel: [item: QueuedPromptItem]
  send: [item: QueuedPromptItem]
}>()

/** Kept-alive conversations stop polling while cached. */
const activated = ref(true)
onActivated(() => {
  activated.value = true
})
onDeactivated(() => {
  activated.value = false
  open.value = false
})
const workspace = useWorkspaceSnapshot({
  active: () => props.build && activated.value,
})

const changes = computed<StatusChanges | null>(() => {
  const snapshot = workspace.snapshot.value
  if (!props.build || props.takeover) return null
  if (snapshot?.sessionId !== props.sessionId || !isGitStatus(snapshot.git))
    return null
  const summary = snapshot.git.summary
  return summary.changedFiles > 0
    ? {
        files: summary.changedFiles,
        additions: summary.additions,
        deletions: summary.deletions,
      }
    : null
})
const todos = computed(() => (props.takeover ? [] : props.todos))
const queue = computed(() => (props.takeover ? [] : props.queue))
const parts = computed(() =>
  statusParts({
    changes: changes.value,
    todos: todos.value,
    goal: props.goal,
    queue: queue.value,
  }),
)
const goalShown = computed(() => parts.value.some((p) => p.key === 'goal'))
const progress = computed(() => todoProgress(todos.value))

const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
/** The panel is as wide as the bar it grows from. */
const panelWidth = ref(420)

async function toggle(): Promise<void> {
  if (!open.value)
    panelWidth.value = Math.max(320, trigger.value?.offsetWidth ?? 420)
  open.value = !open.value
  await nextTick()
}

function close(): void {
  open.value = false
}

function openReview(): void {
  close()
  requestWorkspace({ pane: 'review' })
}

function editGoal(): void {
  close()
  emit('goal-edit')
}

function editQueued(item: QueuedPromptItem): void {
  close()
  emit('edit', item)
}
</script>

<template>
  <div v-if="parts.length" class="composer-status">
    <button
      ref="trigger"
      type="button"
      class="composer-status-bar"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="line">
        <template v-for="(part, index) in parts" :key="part.key">
          <span v-if="index" class="sep" aria-hidden="true"> · </span>
          <span class="part" :data-part="part.key">
            {{ part.text
            }}<template v-if="part.key === 'changes'"
              >&nbsp;<span class="added">+{{ part.additions }}</span
              >&nbsp;<span class="deleted"
                >−{{ part.deletions }}</span
              ></template
            >
          </span>
        </template>
      </span>
      <DsChevronRight :size="14" class="chevron" aria-hidden="true" />
    </button>

    <Popover
      v-model:open="open"
      :anchor="trigger"
      label="输入框状态"
      :width="panelWidth"
      placement="top"
      :padded="false"
      class="composer-status-panel"
    >
      <section v-if="changes" class="section" aria-label="改动">
        <div class="head">
          <span class="title">改动</span>
          <span class="meta">
            {{ changes.files }} 个文件已更改&nbsp;<span class="added"
              >+{{ changes.additions }}</span
            >&nbsp;<span class="deleted">−{{ changes.deletions }}</span>
          </span>
          <LinkButton class="action" @click="openReview">审查</LinkButton>
        </div>
      </section>

      <section v-if="todos.length" class="section" aria-label="待办">
        <div class="head">
          <span class="title">待办</span>
          <span class="meta">{{ progress.done }}/{{ progress.total }}</span>
        </div>
        <ul class="todo-list">
          <li
            v-for="item in todos"
            :key="String(item.id)"
            class="todo"
            :data-status="item.status"
          >
            <span class="glyph" aria-hidden="true">
              <DsCheck v-if="item.status === 'completed'" :size="14" />
              <Spinner v-else-if="item.status === 'in_progress'" size="sm" />
              <span v-else class="pending-marker" />
            </span>
            <span class="todo-text" :title="item.content">{{
              item.content
            }}</span>
          </li>
        </ul>
      </section>

      <StatusGoalSection
        v-if="goal && goalShown"
        :goal="goal"
        :action-pending="goalActionPending ?? null"
        @action="emit('goal-action', $event)"
        @edit="editGoal"
      />

      <StatusQueueSection
        v-if="queue.length"
        :items="queue"
        @send="emit('send', $event)"
        @interject="emit('interject', $event)"
        @cancel="emit('cancel', $event)"
        @edit="editQueued"
      />
    </Popover>
  </div>
</template>

<style scoped>
.composer-status {
  display: flex;
  box-sizing: border-box;
  width: calc(100% - 2 * var(--composer-clearance) - 2 * var(--dock-inset));
  max-width: calc(var(--composer-card-max) - 2 * var(--dock-inset));
  margin: 0 auto;
}

/* One line: the parts, then a chevron at the end. */
.composer-status-bar {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  min-width: 0;
  height: var(--space-8);
  padding: 0 var(--space-2) 0 var(--space-3);
  border: none;
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.composer-status-bar:hover,
.composer-status-bar[aria-expanded='true'] {
  background: rgb(var(--surface-hover-solid));
  color: rgb(var(--text-1));
}

.composer-status-bar:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.line {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sep {
  color: rgb(var(--text-4));
  white-space: pre;
}

.added,
.deleted {
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  font-variant-numeric: tabular-nums;
}

.added {
  color: rgb(var(--state-ok-label));
}

.deleted {
  color: rgb(var(--state-error-label));
}

.chevron {
  flex: none;
  color: rgb(var(--text-3));
}

/* The popover: hairline-separated sections. */
.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  padding: var(--space-2-5) var(--space-3);
}

.section + .section {
  box-shadow: inset 0 0.5px 0 var(--hairline);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--space-6);
}

.title {
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--text-3));
}

.meta {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.action {
  flex: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  max-height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.todo {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.todo[data-status='completed'] .todo-text {
  color: rgb(var(--text-3));
  text-decoration: line-through;
}

.glyph {
  display: grid;
  flex: none;
  place-items: center;
  width: var(--space-4);
  height: var(--space-4);
  color: rgb(var(--text-4));
}

.todo[data-status='completed'] .glyph {
  color: rgb(var(--ok));
}

.todo[data-status='in_progress'] .glyph {
  color: rgb(var(--text-2));
}

.pending-marker {
  box-sizing: border-box;
  width: var(--space-3);
  height: var(--space-3);
  border: 1.5px solid currentColor;
  border-radius: var(--radius-pill);
}

.todo-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
