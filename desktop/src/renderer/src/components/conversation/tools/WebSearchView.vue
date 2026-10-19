<script setup lang="ts">
/** Search hits share resource cards with cited links and the resource index. */
import EmptyState from '../../ui/EmptyState.vue'
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import ResourceCard from '../resources/ResourceCard.vue'
import { displayResource } from '../resources/resourceModel'
import GenericToolCard from './GenericToolCard.vue'
import { webCard } from './toolModel'
const props = defineProps<{ data: ToolChatData }>()
const card = computed(() => webCard(props.data))
const sources = computed(() =>
  (card.value?.sources ?? []).slice(0, 64).flatMap((source) => {
    const resource = displayResource(
      source.url,
      source.title ?? '',
      props.data.callId,
    )
    if (!resource || !['web', 'github'].includes(resource.kind)) return []
    return [
      {
        resource: {
          ...resource,
          provenance: 'discovered' as const,
          ...(source.snippet ? { description: source.snippet } : {}),
        },
        publishedAt: source.publishedAt,
      },
    ]
  }),
)
</script>
<template>
  <div v-if="card" class="web-search-view" data-web="search">
    <div v-if="card.answer" class="answer" v-text="card.answer" />
    <ol v-if="sources.length" class="sources">
      <li
        v-for="(source, index) in sources"
        :key="`${source.resource.id}:${index}`"
      >
        <ResourceCard :resource="source.resource" compact />
        <div
          v-if="source.publishedAt"
          class="published-at"
          v-text="source.publishedAt"
        />
      </li>
    </ol>
    <EmptyState v-else-if="!card.answer" variant="inline" title="未找到结果" />
    <div v-if="card.truncated" class="truncated">来源列表已截断</div>
    <details class="raw-result">
      <summary>原始结果</summary>
      <GenericToolCard :data="data" />
    </details>
  </div>
  <GenericToolCard v-else :data="data" />
</template>
<style scoped>
.web-search-view {
  min-width: 0;
}
.answer {
  margin-bottom: var(--space-2);
  font: var(--font-s);
  color: rgb(var(--label-primary));
  white-space: pre-wrap;
}
.sources {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 440px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.sources li {
  min-width: 0;
}
.published-at {
  margin: calc(0px - var(--space-1)) var(--space-3) var(--space-2);
  font: var(--font-xs);
  color: rgb(var(--label-tertiary));
}
.truncated {
  margin: var(--space-2) 0;
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
