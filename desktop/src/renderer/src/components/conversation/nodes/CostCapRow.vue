<script setup lang="ts">
/** CostCapRow — the per-turn cost cap stopped the turn (warn). */
import { computed } from 'vue'
import type { CostCapChatNode } from '../../../conversation/types'
import { formatUsdNanos } from '../chatFormat'
import NoticeRow from './NoticeRow.vue'

const props = defineProps<{ node: CostCapChatNode }>()
const message = computed(() => {
  const data = props.node.data
  const spent = `已花费 ${formatUsdNanos(data.spentUsdNanos)}，上限 ${formatUsdNanos(data.capUsdNanos)}。`
  return data.unpricedRoutes.length > 0
    ? `${spent} 未计价路由：${data.unpricedRoutes.join('、')}`
    : spent
})
</script>

<template>
  <NoticeRow state="warn" title="已达到单轮费用上限" :message="message" />
</template>
