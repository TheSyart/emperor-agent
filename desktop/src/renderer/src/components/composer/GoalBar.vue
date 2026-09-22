<script setup lang="ts">
/**
 * GoalBar — dsh goal dock (36px, radius 12, tip fill, l1 hairline) above the
 * composer card: goal glyph, phase label, objective, round/elapsed meta and
 * pause / resume / clear (two-step) actions.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RuntimeGoalView } from '../../types'
import {
  toGoalStatusBarViewModel,
  type GoalCardAction,
} from '../../runtime/goalRender'
import { DsGoal, DsLoading, DsTrash } from '../icons/ds'

const props = defineProps<{
  goal: RuntimeGoalView
  actionPending?: GoalCardAction | null
}>()

const emit = defineEmits<{ action: [action: GoalCardAction] }>()

const now = ref(Date.now())
const confirmCancel = ref(false)
let timer: number | undefined

const model = computed(() => toGoalStatusBarViewModel(props.goal, now.value))

watch(
  () => [props.goal.id, props.goal.phase],
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

function runAction(action: GoalCardAction): void {
  if (props.actionPending) return
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
  return confirmCancel.value ? '确认清除 Goal' : '清除 Goal'
}
</script>

<template>
  <section
    v-if="!model.terminal"
    class="goal-dock"
    :data-phase="goal.phase"
    aria-label="当前 Goal"
  >
    <div class="bar" role="status">
      <DsGoal :size="14" class="glyph" aria-hidden="true" />
      <span class="label">{{ model.phaseLabel }}</span>
      <span class="objective" :title="model.objective">{{
        model.objective
      }}</span>
      <span class="meta"
        >{{ model.roundLabel }} · {{ model.elapsedLabel }}</span
      >
      <div class="actions">
        <button
          v-for="action in model.actions"
          :key="action"
          type="button"
          class="icon"
          :data-danger="(action === 'cancel' && confirmCancel) || undefined"
          :aria-label="actionLabel(action)"
          :title="actionLabel(action)"
          :disabled="Boolean(actionPending)"
          @click="runAction(action)"
        >
          <DsLoading
            v-if="actionPending === action"
            :size="14"
            class="spin"
            aria-hidden="true"
          />
          <svg
            v-else-if="action === 'resume'"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
          >
            <path d="M4 2.5v9l7.5-4.5z" fill="currentColor" />
          </svg>
          <svg
            v-else-if="action === 'pause'"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
          >
            <rect
              x="3.5"
              y="2.5"
              width="2.2"
              height="9"
              rx="0.6"
              fill="currentColor"
            />
            <rect
              x="8.3"
              y="2.5"
              width="2.2"
              height="9"
              rx="0.6"
              fill="currentColor"
            />
          </svg>
          <DsTrash v-else :size="14" aria-hidden="true" />
        </button>
      </div>
    </div>
    <p v-if="model.notice" class="notice">{{ model.notice }}</p>
  </section>
</template>

<style scoped>
.goal-dock {
  box-sizing: border-box;
  width: calc(100% - 2 * var(--composer-clearance) - 4 * var(--dock-inset));
  max-width: calc(var(--composer-card-max) - 4 * var(--dock-inset));
  margin: 0 auto;
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: var(--space-1) calc(var(--space-1) + 1px) var(--space-1)
    var(--space-3);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--tip-fill));
}

.glyph {
  flex: none;
  color: rgb(var(--accent-strong));
}

.label {
  flex: none;
  font-size: var(--fs-xs);
  line-height: var(--space-6);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.objective {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
}

.icon {
  display: inline-grid;
  place-items: center;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.icon:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
}

.icon[data-danger] {
  color: rgb(var(--danger));
  background: var(--interactive-bg-hover-danger);
}

.icon:disabled {
  opacity: 0.4;
  cursor: default;
}

.spin {
  animation: goal-spin 1s linear infinite;
}

@keyframes goal-spin {
  to {
    transform: rotate(360deg);
  }
}

.notice {
  margin: var(--space-1) var(--space-3) 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--danger));
}
</style>
