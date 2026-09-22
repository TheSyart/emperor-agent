<script setup lang="ts">
/**
 * SubagentView — delegated task body: the prompt (IN), the child's final
 * text (OUT, markdown). The child-session link sits on the tree's status
 * line; child activity is never inlined.
 */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import ConversationMarkdown from '../parts/ConversationMarkdown.vue'
import { argsOf, resultText, stringArg } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const prompt = computed(() => stringArg(argsOf(props.data), 'prompt') ?? '')
const output = computed(() => {
  const sub = props.data.subagent
  if (sub?.text !== undefined && sub.text !== '') return sub.text
  if (props.data.result?.isError === true) return resultText(props.data)
  return ''
})
</script>

<template>
  <div class="subagent-view">
    <div v-if="prompt" class="section">
      <span class="label">任务</span>
      <div class="prompt">{{ prompt }}</div>
    </div>
    <div v-if="output" class="section">
      <span class="label">结果</span>
      <div class="output" :data-error="data.result?.isError || undefined">
        <ConversationMarkdown :text="output" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
}

.section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: var(--space-3-5);
  align-items: baseline;
}

.label {
  font: var(--font-code-small);
  color: rgb(var(--label-caption));
}

.prompt {
  max-height: 120px;
  overflow-y: auto;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.output {
  max-height: 220px;
  overflow-y: auto;
}

.output :deep(.ds-md) {
  gap: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.output[data-error] :deep(.ds-md) {
  color: rgb(var(--danger));
}
</style>
