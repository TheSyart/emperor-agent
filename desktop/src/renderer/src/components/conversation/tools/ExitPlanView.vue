<script setup lang="ts">
/**
 * ExitPlanView — the finalized plan (markdown) with the review result
 * (replaces PlanCard): approved / keep planning (+ feedback) / cancelled.
 */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import StateDot from '../../ui/StateDot.vue'
import type { StateDotState } from '../../ui/stateDot'
import ConversationMarkdown from '../parts/ConversationMarkdown.vue'
import { PLAN_OUTCOME_LABEL, argsOf, planOutcome, stringArg } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const plan = computed(() => stringArg(argsOf(props.data), 'plan') ?? '')
const outcome = computed(() => planOutcome(props.data))
const dot = computed<StateDotState>(() => {
  switch (outcome.value.outcome) {
    case 'approved':
      return 'ok'
    case 'waiting':
      return 'ongoing'
    case 'failed':
      return 'error'
    default:
      return 'warn'
  }
})
</script>

<template>
  <div class="plan-view">
    <div class="plan-body">
      <ConversationMarkdown :text="plan" />
    </div>
    <div class="result" :data-outcome="outcome.outcome">
      <StateDot :state="dot" />
      <span class="label">{{ PLAN_OUTCOME_LABEL[outcome.outcome] }}</span>
      <span v-if="outcome.feedback" class="feedback">{{
        outcome.feedback
      }}</span>
    </div>
  </div>
</template>

<style scoped>
.plan-view {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgb(var(--approval) / 0.35);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-1));
}

.plan-body {
  max-height: 360px;
  padding: var(--space-4) var(--space-5);
  overflow-y: auto;
}

.plan-body :deep(.ds-md) {
  font-size: var(--fs-s);
  line-height: var(--lh-base);
}

.plan-body :deep(.ds-md h1) {
  font-size: var(--fs-md);
  line-height: var(--lh-md);
}

.result {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-l2);
  background: rgb(var(--approval-soft));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.label {
  flex: none;
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.feedback {
  min-width: 0;
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}
</style>
