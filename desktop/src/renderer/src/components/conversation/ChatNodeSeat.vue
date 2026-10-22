<script setup lang="ts">
/**
 * ChatNodeSeat — subscribes to ONE node key (per-key shallowRef from the
 * conversation store) and dispatches by kind, so a streaming delta
 * re-renders exactly one row. The seat owns the 16px flow gap (dropped when
 * the row renders nothing); `dense` seats inside a process group keep 4px.
 *
 * Props: handle (ConversationHandle), nodeKey, closing (an assistant row
 * directly followed by its turn tail), part ('reasoning' | 'answer': which
 * blocks of an assistant step this seat shows), dense.
 */
import { computed, defineAsyncComponent, type Component } from 'vue'
import type { ConversationHandle } from '../../conversation/store'
import type { ChatNodeKind } from '../../conversation/types'
import JsonTree from '../ui/JsonTree.vue'
import AssistantStep from './nodes/AssistantStep.vue'
import CompactionRow from './nodes/CompactionRow.vue'
import ContextRow from './nodes/ContextRow.vue'
import CostCapRow from './nodes/CostCapRow.vue'
import FallbackRow from './nodes/FallbackRow.vue'
import GoalRow from './nodes/GoalRow.vue'
import HookRow from './nodes/HookRow.vue'
import RetryRow from './nodes/RetryRow.vue'
import ToolCallTree from './nodes/ToolCallTree.vue'
import TurnBudgetRow from './nodes/TurnBudgetRow.vue'
import TurnErrorRow from './nodes/TurnErrorRow.vue'
import TurnFilesCard from './nodes/TurnFilesCard.vue'
import TurnMaxTokensRow from './nodes/TurnMaxTokensRow.vue'
import TurnTail from './nodes/TurnTail.vue'
import UserBubble from './nodes/UserBubble.vue'
import WorkflowRunNode from './nodes/WorkflowRunNode.vue'

const props = withDefaults(
  defineProps<{
    handle: ConversationHandle
    nodeKey: string
    closing?: boolean
    part?: 'reasoning' | 'answer'
    dense?: boolean
  }>(),
  { closing: false, part: undefined, dense: false },
)

const RENDERERS: Record<ChatNodeKind, Component> = {
  user: UserBubble,
  assistant: AssistantStep,
  tool: ToolCallTree,
  retry: RetryRow,
  fallback: FallbackRow,
  turnError: TurnErrorRow,
  turnMaxTokens: TurnMaxTokensRow,
  turnBudget: TurnBudgetRow,
  costCap: CostCapRow,
  compaction: CompactionRow,
  context: ContextRow,
  hook: HookRow,
  turnTail: TurnTail,
  turnFiles: TurnFilesCard,
  // A subagent's result card loads with the first one (AGT-06).
  delegationResult: defineAsyncComponent(
    () => import('./nodes/DelegationResultCard.vue'),
  ),
  goal: GoalRow,
  workflowRun: WorkflowRunNode,
}

const nodeRef = computed(() => props.handle.node(props.nodeKey))
const node = computed(() => nodeRef.value.value)
const renderer = computed(() =>
  node.value === undefined ? undefined : RENDERERS[node.value.kind],
)
</script>

<template>
  <div
    v-if="node"
    class="chat-seat"
    :data-dense="dense || undefined"
    :data-chat-anchor-key="node.key"
    :data-chat-flow-kind="node.kind"
    :data-chat-turn="node.turn ?? undefined"
  >
    <component
      :is="renderer"
      v-if="renderer"
      :node="node"
      v-bind="node.kind === 'assistant' ? { closing, part } : {}"
    />
    <JsonTree v-else :value="node" />
  </div>
</template>

<style scoped>
.chat-seat {
  min-width: 0;
  padding-bottom: var(--space-4);
}

.chat-seat[data-dense] {
  padding-bottom: var(--space-1);
}

/* Narration between steps reads one level below the answer. */
.chat-seat[data-dense] :deep(.ds-md) {
  color: rgb(var(--text-2));
}

.chat-seat:empty {
  padding-bottom: 0;
}
</style>
