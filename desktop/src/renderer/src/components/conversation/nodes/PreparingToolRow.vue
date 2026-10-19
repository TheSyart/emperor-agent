<script setup lang="ts">
/**
 * PreparingToolRow — a call the model is still writing (DSH-23 three
 * stages: preparing → running → result): the tool row with the arguments
 * parsed so far (the file name, the command) and 「准备中」. It reads the
 * call from its assistant step's streamed draft, and gives way to the real
 * tool row once `tool/call` lands.
 *
 * Props: handle, nodeKey (the assistant step), index (its call block).
 */
import { computed } from 'vue'
import type { ConversationHandle } from '../../../conversation/store'
import { preparingToolData } from '../processModel'
import ToolCallRow from './ToolCallRow.vue'

const props = defineProps<{
  handle: ConversationHandle
  nodeKey: string
  index: number
}>()

const nodeRef = computed(() => props.handle.node(props.nodeKey))
const data = computed(() => {
  const node = nodeRef.value.value
  return node?.kind === 'assistant'
    ? preparingToolData(node, props.index)
    : null
})
</script>

<template>
  <div v-if="data" class="preparing" data-process-step>
    <ToolCallRow :data="data" preparing />
  </div>
</template>

<style scoped>
.preparing {
  min-width: 0;
  padding-bottom: var(--space-1);
}
</style>
