<script setup lang="ts">
import {
  Check,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Target,
  Trash2,
  X,
} from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RuntimeGoalSummary } from '../../types'
import {
  toGoalStatusBarViewModel,
  type GoalCardAction,
} from '../../runtime/goalRender'

const props = defineProps<{
  goal: RuntimeGoalSummary
  actionPending?: GoalCardAction | null
  replacing?: boolean
  replaceError?: string | null
}>()

const emit = defineEmits<{
  action: [action: GoalCardAction]
  edit: [outcome: string]
}>()

const now = ref(Date.now())
const editing = ref(false)
const draft = ref('')
const localError = ref('')
const confirmCancel = ref(false)
const outcomeInput = ref<HTMLInputElement | null>(null)
let timer: number | undefined

const model = computed(() => toGoalStatusBarViewModel(props.goal, now.value))
const displayedError = computed(
  () => localError.value || props.replaceError || '',
)

watch(() => props.goal.id, resetLocalState)
watch(
  () => props.goal.phase,
  () => {
    confirmCancel.value = false
  },
)

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1_000)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

function resetLocalState(): void {
  editing.value = false
  draft.value = ''
  localError.value = ''
  confirmCancel.value = false
}

function startEditing(): void {
  draft.value = props.goal.outcome
  localError.value = ''
  editing.value = true
  void nextTick(() => {
    outcomeInput.value?.focus()
    outcomeInput.value?.select()
  })
}

function closeEditing(): void {
  if (props.replacing) return
  editing.value = false
  localError.value = ''
}

function submitEdit(): void {
  const outcome = draft.value.trim()
  if (!outcome) {
    localError.value = 'Outcome 不能为空。'
    outcomeInput.value?.focus()
    return
  }
  if (outcome === props.goal.outcome.trim()) {
    closeEditing()
    return
  }
  localError.value = ''
  emit('edit', outcome)
}

function runAction(action: GoalCardAction): void {
  if (props.actionPending || props.replacing) return
  if (action === 'cancel' && !confirmCancel.value) {
    confirmCancel.value = true
    return
  }
  confirmCancel.value = false
  emit('action', action)
}

function actionLabel(action: GoalCardAction): string {
  if (action === 'resume') return '恢复 Goal'
  if (action === 'pause') return '暂停 Goal'
  return confirmCancel.value ? '确认取消 Goal' : '取消 Goal'
}
</script>

<template>
  <section
    v-if="!model.terminal"
    class="goal-status-shell"
    :data-phase="goal.phase"
    aria-label="当前 Goal"
  >
    <div class="goal-status-bar" role="status">
      <Target :size="15" class="goal-status-mark" aria-hidden="true" />
      <div class="goal-status-copy">
        <span>{{ model.phaseLabel }}</span>
        <strong :title="model.outcome">{{ model.outcome }}</strong>
        <time>{{ model.elapsedLabel }}</time>
      </div>
      <div class="goal-status-actions">
        <button
          type="button"
          aria-label="编辑 Goal Outcome"
          title="用新的 Outcome 替换当前 Goal"
          :disabled="Boolean(actionPending) || replacing"
          @click="startEditing"
        >
          <Pencil :size="14" aria-hidden="true" />
        </button>
        <button
          v-for="action in model.actions"
          :key="action"
          type="button"
          :class="{ danger: action === 'cancel' && confirmCancel }"
          :aria-label="actionLabel(action)"
          :title="actionLabel(action)"
          :disabled="Boolean(actionPending) || replacing"
          @click="runAction(action)"
        >
          <LoaderCircle
            v-if="actionPending === action"
            :size="14"
            class="goal-status-spin"
            aria-hidden="true"
          />
          <Play v-else-if="action === 'resume'" :size="14" aria-hidden="true" />
          <Pause v-else-if="action === 'pause'" :size="14" aria-hidden="true" />
          <Trash2 v-else :size="14" aria-hidden="true" />
        </button>
      </div>
    </div>

    <form
      v-if="editing"
      class="goal-status-editor"
      @submit.prevent="submitEdit"
    >
      <label for="goal-outcome-edit">替换 Outcome</label>
      <div class="goal-status-editor-row">
        <input
          id="goal-outcome-edit"
          ref="outcomeInput"
          v-model="draft"
          aria-label="Goal Outcome"
          maxlength="4000"
          :disabled="replacing"
        />
        <button
          type="submit"
          aria-label="确认替换 Goal"
          title="确认替换 Goal"
          :disabled="replacing"
        >
          <LoaderCircle
            v-if="replacing"
            :size="14"
            class="goal-status-spin"
            aria-hidden="true"
          />
          <Check v-else :size="14" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="关闭 Outcome 编辑"
          title="关闭"
          :disabled="replacing"
          @click="closeEditing"
        >
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <p v-if="displayedError" class="goal-status-error" role="alert">
        {{ displayedError }}
      </p>
      <small>确认后会结束当前 Goal，并创建保留审计关系的替代 Goal。</small>
    </form>
  </section>
</template>

<style scoped>
.goal-status-shell {
  width: min(760px, 100%);
  margin-inline: auto;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius);
  background: rgb(var(--bg-elevated) / 0.96);
  box-shadow: 0 10px 28px rgb(var(--shadow-color) / 0.16);
}

.goal-status-shell[data-phase='paused'] {
  border-color: rgb(var(--border-strong));
}

.goal-status-bar {
  display: flex;
  align-items: center;
  min-height: 38px;
  gap: var(--space-2);
  padding: var(--space-1) 7px 5px 11px;
}

.goal-status-mark {
  flex: 0 0 auto;
  color: rgb(var(--accent));
}

.goal-status-copy {
  display: flex;
  align-items: baseline;
  min-width: 0;
  flex: 1;
  gap: var(--space-2);
}

.goal-status-copy span {
  flex: 0 0 auto;
  color: rgb(var(--fg));
  font-size: var(--font-size-sm);
  font-weight: 640;
}

.goal-status-copy strong {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-xs);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-status-copy time {
  flex: 0 0 auto;
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-2xs);
}

.goal-status-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.goal-status-actions button,
.goal-status-editor button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: rgb(var(--fg-subtle));
  cursor: pointer;
}

.goal-status-actions button:hover:not(:disabled),
.goal-status-editor button:hover:not(:disabled) {
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg));
}

.goal-status-actions button.danger {
  background: rgb(var(--danger) / 0.12);
  color: rgb(var(--danger));
}

.goal-status-actions button:disabled,
.goal-status-editor button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.goal-status-editor {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-2) 10px 10px;
  border-top: 1px solid rgb(var(--border));
}

.goal-status-editor > label {
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-2xs);
  font-weight: 620;
}

.goal-status-editor-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.goal-status-editor input {
  min-width: 0;
  min-height: 32px;
  flex: 1;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  padding: 0 9px;
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg));
  font: inherit;
  font-size: var(--font-size-xs);
}

.goal-status-editor input:focus {
  border-color: rgb(var(--accent) / 0.72);
  outline: 0;
  box-shadow: 0 0 0 3px rgb(var(--accent) / 0.12);
}

.goal-status-editor small,
.goal-status-error {
  margin: 0;
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-2xs);
}

.goal-status-error {
  color: rgb(var(--danger));
}

.goal-status-spin {
  animation: goal-status-spin 800ms linear infinite;
}

@keyframes goal-status-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .goal-status-copy {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 1px 6px;
  }

  .goal-status-copy strong {
    grid-column: 1 / -1;
  }

  .goal-status-copy time {
    justify-self: end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .goal-status-spin {
    animation: none;
  }
}
</style>
