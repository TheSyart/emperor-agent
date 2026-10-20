<script setup lang="ts">
/**
 * TurnBudgetRow — the task budget ended the turn (KRN-03, warn): it took
 * the most steps one turn may take, or the task (the conversation, its
 * subagents and failed attempts) spent its cost cap.
 */
import { computed } from 'vue'
import type { TurnBudgetChatNode } from '../../../conversation/types'
import { formatUsdNanos } from '../chatFormat'
import NoticeRow from './NoticeRow.vue'

const props = defineProps<{ node: TurnBudgetChatNode }>()

const title = computed(() =>
  props.node.data.reason.limit === 'steps'
    ? '已达到单轮步数上限'
    : '已达到任务费用上限',
)
const message = computed(() => {
  const reason = props.node.data.reason
  if (reason.limit === 'steps')
    return `本轮已执行 ${reason.maxSteps} 步，已停止。可以让我继续；上限在「设置 › 高级 › 任务预算」。`
  if (reason.unpricedRoutes?.length)
    return `模型 ${reason.unpricedRoutes.join('、')} 没有单价，无法执行费用上限，已停止。`
  return `本任务（含子智能体与失败的请求）已花费 ${formatUsdNanos(reason.spentUsdNanos)}，上限 ${formatUsdNanos(reason.capUsdNanos)}。发下一条消息后重新计算。`
})
</script>

<template>
  <NoticeRow state="warn" :title="title" :message="message" />
</template>
