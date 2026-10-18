<script setup lang="ts">
/** Structured web/MCP results keep the same resource identity as the sidebar. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import ResourceCard from '../resources/ResourceCard.vue'
import { toolResources } from '../resources/resourceIndex'
import GenericToolCard from './GenericToolCard.vue'
import { metaOf } from './toolModel'
const props = defineProps<{ data: ToolChatData }>()
const resources = computed(() => toolResources(props.data))
const meta = computed(() => metaOf(props.data))
const statusCode = computed(() =>
  typeof meta.value?.statusCode === 'number' &&
  Number.isInteger(meta.value.statusCode)
    ? meta.value.statusCode
    : null,
)
</script>
<template>
  <div v-if="resources.length" class="resource-tool-view">
    <ResourceCard
      v-for="(resource, index) in resources"
      :key="`${resource.role}:${resource.id}:${index}`"
      :resource="resource"
      :group="resources"
      compact
    />
    <div v-if="statusCode !== null || meta?.truncated" class="result-meta">
      <span v-if="statusCode !== null">HTTP {{ statusCode }}</span>
      <span v-if="meta?.truncated === true">内容已截断</span>
    </div>
    <details class="raw-result">
      <summary>原始结果</summary>
      <GenericToolCard :data="data" />
    </details>
  </div>
  <GenericToolCard v-else :data="data" />
</template>
<style scoped>
.resource-tool-view {
  min-width: 0;
}
.result-meta {
  display: flex;
  gap: var(--space-3);
  margin: var(--space-1) 0 var(--space-2);
  font: var(--font-xs);
  color: rgb(var(--label-tertiary));
}
.raw-result > summary {
  padding: var(--space-1) 0;
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
  cursor: pointer;
}
.raw-result[open] > summary {
  margin-bottom: var(--space-1);
}
</style>
