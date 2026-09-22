<script setup lang="ts">
/**
 * TurnTail — footer of a completed turn (dsh TurnTailNodeView): copy of the
 * final answer and the hover caption `14:05 · 用时 12s · 首字 0.8s ·
 * 34 tok/s`. Renders nothing when the turn left no text.
 */
import { computed } from 'vue'
import type { TurnTailChatNode } from '../../../conversation/types'
import Tooltip from '../../ui/Tooltip.vue'
import { formatTokens } from '../chatFormat'
import MessageIconActions from '../parts/MessageIconActions.vue'

const props = defineProps<{ node: TurnTailChatNode }>()
const data = computed(() => props.node.data)
const usageLabel = computed(() => {
  const usage = data.value.usage
  const parts = [
    `输入 ${formatTokens(usage.inputTokens)}`,
    `输出 ${formatTokens(usage.outputTokens)}`,
  ]
  if (usage.cacheReadTokens > 0)
    parts.push(`缓存命中 ${formatTokens(usage.cacheReadTokens)}`)
  if (usage.reasoningTokens > 0)
    parts.push(`推理 ${formatTokens(usage.reasoningTokens)}`)
  parts.push(`${data.value.steps} 步`)
  return parts.join(' · ')
})
</script>

<template>
  <div
    v-if="data.closingText !== null"
    class="turn-tail"
    :data-turn-tail="data.turn"
    data-time-hover-root
  >
    <MessageIconActions
      :text="data.closingText"
      :time="data.endedAt"
      :run-ms="data.durationMs"
      :ttft-ms="data.ttftMs"
      :tokens-per-second="data.tokensPerSecond"
      clock="end"
    >
      <Tooltip :label="usageLabel" side="bottom">
        <span class="usage" tabindex="0">{{
          formatTokens(data.usage.inputTokens + data.usage.outputTokens)
        }}</span>
      </Tooltip>
    </MessageIconActions>
  </div>
</template>

<style scoped>
.turn-tail {
  display: flex;
  flex-direction: column;
  margin-left: calc(0px - var(--space-1-5));
}

.usage {
  display: inline-flex;
  align-items: center;
  height: var(--space-7);
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--label-caption));
  opacity: 0;
  transition: opacity var(--duration-instant) ease;
}

.turn-tail:hover .usage,
.turn-tail:focus-within .usage {
  opacity: 1;
}
</style>
