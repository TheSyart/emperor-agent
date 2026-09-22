<script setup lang="ts">
/**
 * GoalRow — one goal mutation inline: `目标 · 已创建 · {objective}` with a
 * phase dot; a blocked goal expands to its reason.
 */
import { computed } from 'vue'
import type { GoalChatNode } from '../../../conversation/types'
import { DsGoal } from '../../icons/ds'
import DisclosureRow from '../../ui/DisclosureRow.vue'
import StateDot from '../../ui/StateDot.vue'
import type { StateDotState } from '../../ui/stateDot'
import { useExpansion } from '../chatContext'

const props = defineProps<{ node: GoalChatNode }>()
const open = useExpansion(() => `${props.node.key}:body`)

const OPERATION_LABEL: Record<string, string> = {
  create: '已创建',
  edit: '已修改',
  pause: '已暂停',
  resume: '已恢复',
  complete: '已完成',
  block: '受阻',
  clear: '已清除',
}
const PHASE_DOT: Record<string, StateDotState> = {
  active: 'ongoing',
  paused: 'warn',
  blocked: 'error',
  complete: 'ok',
}

const data = computed(() => props.node.data)
const summary = computed(() =>
  [
    OPERATION_LABEL[data.value.operation] ?? data.value.operation,
    data.value.objective,
    data.value.maxGoalRounds !== undefined &&
    data.value.roundsStarted !== undefined
      ? `第 ${data.value.roundsStarted}/${data.value.maxGoalRounds} 轮`
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · '),
)
const dot = computed(() =>
  data.value.phase === undefined ? undefined : PHASE_DOT[data.value.phase],
)
</script>

<template>
  <div class="goal-row">
    <DisclosureRow
      v-model:open="open"
      title="目标"
      :summary="summary"
      :expandable="data.blockedReason !== undefined"
      :tone="data.phase === 'blocked' ? 'error' : 'default'"
    >
      <template #icon>
        <StateDot v-if="dot && dot !== 'ongoing'" :state="dot" />
        <DsGoal v-else :size="14" />
      </template>
      <div v-if="data.blockedReason" class="reason">
        {{ data.blockedReason.message }}
        <code class="code">{{ data.blockedReason.code }}</code>
      </div>
    </DisclosureRow>
  </div>
</template>

<style scoped>
.reason {
  margin: var(--space-1) 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.code {
  margin-left: var(--space-1-5);
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
}
</style>
