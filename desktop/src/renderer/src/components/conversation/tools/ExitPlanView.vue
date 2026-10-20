<script setup lang="ts">
/**
 * ExitPlanView — the finalized plan (markdown) with the review result
 * (replaces PlanCard): approved / keep planning (+ feedback) / cancelled.
 */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import Dot from '../../ui/Dot.vue'
import type { DotState } from '../../ui/dot'
import ConversationMarkdown from '../parts/ConversationMarkdown.vue'
import { PLAN_OUTCOME_LABEL, argsOf, planOutcome, stringArg } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const plan = computed(() => stringArg(argsOf(props.data), 'plan') ?? '')
const outcome = computed(() => planOutcome(props.data))
const dot = computed<DotState>(() => {
  switch (outcome.value.outcome) {
    case 'approved':
      return 'ok'
    case 'waiting':
      return 'running'
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
      <Dot :state="dot" />
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
  border: 1px solid rgb(var(--attention) / 0.35);
  border-radius: var(--radius-card);
  background: rgb(var(--surface-base));
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
  border-top: 1px solid var(--stroke-2);
  background: rgb(var(--attention-soft));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.label {
  flex: none;
  font-weight: 600;
  color: rgb(var(--text-1));
}

.feedback {
  min-width: 0;
  color: rgb(var(--text-2));
  overflow-wrap: anywhere;
}
</style>
