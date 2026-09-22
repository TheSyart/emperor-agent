<script setup lang="ts">
/**
 * WorkflowView — workflow / ralph body: the run panel is rendered by the
 * tool tree beneath the row, so the body shows the objective/script and
 * the final result.
 */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import CodeBlock from '../../ui/CodeBlock.vue'
import InOutCard from '../../ui/InOutCard.vue'
import { argsOf, resultText, stringArg } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const args = computed(() => argsOf(props.data))
const script = computed(() => stringArg(args.value, 'script'))
const objective = computed(() => stringArg(args.value, 'objective'))
const output = computed(() =>
  props.data.result === undefined
    ? undefined
    : (props.data.workflow?.result ?? resultText(props.data)),
)
</script>

<template>
  <div class="workflow-view">
    <CodeBlock v-if="script" :code="script" lang="javascript" small />
    <InOutCard
      :input="objective"
      :output="output"
      :error="data.result?.isError === true"
    />
  </div>
</template>

<style scoped>
.workflow-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.workflow-view :deep(.ds-code pre) {
  max-height: 260px;
  overflow-y: auto;
}
</style>
