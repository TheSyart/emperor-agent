<script setup lang="ts">
/** WorkflowRunNode — a workflow run not started by a tool call. */
import type { WorkflowRunChatNode } from '../../../conversation/types'
import WorkflowRunPanel from './WorkflowRunPanel.vue'

defineProps<{ node: WorkflowRunChatNode }>()
</script>

<template>
  <WorkflowRunPanel :run="node.data" :expansion-key="node.key" />
</template>
