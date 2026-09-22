<script setup lang="ts">
/** McpView — MCP server badge over the IN/OUT JsonTree card. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import Pill from '../../ui/Pill.vue'
import GenericToolCard from './GenericToolCard.vue'
import { mcpIdentity } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const identity = computed(() => mcpIdentity(props.data))
</script>

<template>
  <div class="mcp-view">
    <div v-if="identity" class="badges">
      <Pill>MCP · {{ identity.server }}</Pill>
      <span class="tool">{{ identity.tool }}</span>
    </div>
    <GenericToolCard :data="data" />
  </div>
</template>

<style scoped>
.mcp-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.badges {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tool {
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
}
</style>
