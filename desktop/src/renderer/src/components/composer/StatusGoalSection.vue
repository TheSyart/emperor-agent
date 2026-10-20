<script setup lang="ts">
/**
 * StatusGoalSection — the 目标 section of the composer status bar's popover
 * (UI-S04): phase, objective, round and elapsed time, the blocked / paused
 * notice, and three actions — 暂停 or 恢复, 编辑 (once paused or blocked:
 * the goal is cleared and its objective goes back into the composer to be
 * described again) and 清除, which asks first.
 *
 * Props: goal, actionPending (the action Core is still running).
 * Emits: action(pause | resume | cancel), edit.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RuntimeGoalView } from '../../types'
import {
  toGoalStatusBarViewModel,
  type GoalCardAction,
} from '../../runtime/goalRender'
import Button from '../ui/Button.vue'
import { confirm } from '../ui/confirm'

const props = defineProps<{
  goal: RuntimeGoalView
  actionPending: GoalCardAction | null
}>()

const emit = defineEmits<{ action: [action: GoalCardAction]; edit: [] }>()

const now = ref(Date.now())
let timer: number | undefined
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1_000)
})
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

const model = computed(() => toGoalStatusBarViewModel(props.goal, now.value))
/** Pause or resume, whichever the phase allows. */
const toggleAction = computed<GoalCardAction>(() =>
  model.value.actions.includes('resume') ? 'resume' : 'pause',
)
/** A running goal is paused before it is edited. */
const editable = computed(() => model.value.actions.includes('resume'))

function run(action: GoalCardAction): void {
  if (props.actionPending) return
  emit('action', action)
}

async function clear(): Promise<void> {
  if (props.actionPending) return
  const confirmed = await confirm({
    title: '清除这个 Goal？',
    body: '已完成的工作会保留，Goal 不再继续推进。',
    confirmLabel: '清除',
    tone: 'danger',
  })
  if (confirmed) emit('action', 'cancel')
}
</script>

<template>
  <section class="section goal" aria-label="目标" :data-phase="goal.phase">
    <div class="head">
      <span class="title">目标</span>
      <span class="phase">{{ model.phaseLabel }}</span>
      <span class="meta"
        >{{ model.roundLabel }} · {{ model.elapsedLabel }}</span
      >
    </div>
    <p class="objective" :title="model.objective">{{ model.objective }}</p>
    <p v-if="model.notice" class="notice">{{ model.notice }}</p>
    <div class="actions">
      <Button
        size="sm"
        variant="secondary"
        :aria-label="toggleAction === 'resume' ? '恢复 Goal' : '暂停 Goal'"
        :loading="actionPending === toggleAction"
        :disabled="Boolean(actionPending) && actionPending !== toggleAction"
        @click="run(toggleAction)"
      >
        {{ toggleAction === 'resume' ? '恢复' : '暂停' }}
      </Button>
      <Button
        size="sm"
        aria-label="编辑 Goal"
        :title="editable ? undefined : '暂停后才能编辑'"
        :disabled="!editable || Boolean(actionPending)"
        @click="emit('edit')"
      >
        编辑
      </Button>
      <Button
        size="sm"
        aria-label="清除 Goal"
        :loading="actionPending === 'cancel'"
        :disabled="Boolean(actionPending) && actionPending !== 'cancel'"
        @click="clear"
      >
        清除
      </Button>
    </div>
  </section>
</template>

<style scoped>
.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  padding: var(--space-2-5) var(--space-3);
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

.phase {
  flex: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--text-1));
}

.meta {
  margin-left: auto;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
  font-variant-numeric: tabular-nums;
}

.objective {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.notice {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.goal[data-phase='blocked'] .notice {
  color: rgb(var(--error));
}

.actions {
  display: flex;
  gap: var(--space-1);
}
</style>
