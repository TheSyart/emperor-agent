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
import type { RuntimeGoalView } from '../../../types'

const props = defineProps<{
  node: TurnBudgetChatNode
  goal?: RuntimeGoalView | null
}>()

const automatic = computed(
  () =>
    props.node.data.reason.limit === 'steps' &&
    props.goal?.phase === 'active' &&
    props.goal.activation === 'armed',
)
const resumable = computed(
  () =>
    props.node.data.reason.limit === 'steps' &&
    props.goal?.phase === 'active' &&
    props.goal.activation === 'disarmed',
)

const title = computed(() =>
  props.node.data.reason.limit === 'steps'
    ? '已达到单轮步数上限'
    : '已达到任务费用上限',
)
const message = computed(() => {
  const reason = props.node.data.reason
  if (reason.limit === 'steps') {
    if (automatic.value)
      return `本轮已执行 ${reason.maxSteps} 步，断点已保存，正在自动继续；无需发送“继续”。上限在「设置 › 高级 › 任务预算」。`
    if (resumable.value)
      return `本轮已执行 ${reason.maxSteps} 步，断点已保留，可恢复目标后继续。上限在「设置 › 高级 › 任务预算」。`
    return `本轮已执行 ${reason.maxSteps} 步，已停止。可以让我继续；上限在「设置 › 高级 › 任务预算」。`
  }
  // A route without prices is not counted (MOD-05): say so after the spend.
  const unpriced = reason.unpricedRoutes?.length
    ? `模型 ${reason.unpricedRoutes.join('、')} 没有单价，未计入。`
    : ''
  return `本任务（含子智能体与失败的请求）已花费 ${formatUsdNanos(reason.spentUsdNanos)}，上限 ${formatUsdNanos(reason.capUsdNanos)}。${unpriced}已保留断点，不会自动续跑；发下一条消息后重新计算。`
})
</script>

<template>
  <NoticeRow
    :state="automatic ? 'running' : 'warn'"
    :title="title"
    :message="message"
  />
</template>
