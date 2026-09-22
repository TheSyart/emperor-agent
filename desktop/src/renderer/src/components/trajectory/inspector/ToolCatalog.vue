<script setup lang="ts">
/**
 * ToolCatalog — Tools tab of a request header: one disclosure per tool
 * (name + one-line description), expanding to the full description and the
 * parameters JsonTree.
 *
 * Props: tools (ToolSchema[]).
 */
import type { ToolSchema } from '@emperor/core/runtime-contract'
import DsChevronRight from '../../icons/ds/DsChevronRight.vue'
import JsonTree from '../../ui/JsonTree.vue'

defineProps<{ tools: readonly ToolSchema[] }>()
</script>

<template>
  <p v-if="tools.length === 0" class="no-payload">No tools in this request</p>
  <div v-else class="traj-tool-catalog">
    <details
      v-for="(tool, index) in tools"
      :key="`${tool.name}:${index}`"
      class="item"
    >
      <summary class="summary">
        <DsChevronRight :size="12" class="chevron" />
        <svg
          class="glyph"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="name">{{ tool.name }}</span>
        <span class="description">{{ tool.description }}</span>
      </summary>
      <div class="definition">
        <p v-if="tool.description" class="full-description">
          {{ tool.description }}
        </p>
        <JsonTree :value="tool.parameters" :expand-depth="2" />
      </div>
    </details>
  </div>
</template>

<style scoped>
.no-payload {
  margin: 0;
  padding: var(--space-4) var(--space-3-5);
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
}

.traj-tool-catalog {
  padding: var(--space-2) 0 var(--space-4);
}

.item {
  border-bottom: 1px solid var(--border-l1);
}

.summary {
  display: grid;
  grid-template-columns: 12px 12px max-content minmax(0, 1fr);
  align-items: center;
  gap: var(--space-1);
  min-height: 30px;
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.summary::-webkit-details-marker {
  display: none;
}

.summary:hover {
  background: var(--interactive-bg-hover);
}

.chevron,
.glyph {
  color: rgb(var(--label-caption));
}

.chevron {
  transition: transform var(--duration-fast) var(--ease-in-out);
}

.item[open] .chevron {
  transform: rotate(90deg);
}

.name {
  color: rgb(var(--label-primary));
  font: 500 12px / 18px var(--font-mono);
}

.description {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.definition {
  padding: 0 0 var(--space-2) var(--space-7);
  background: rgb(var(--bg-base));
}

.full-description {
  margin: 0;
  padding: var(--space-2) var(--space-3-5) var(--space-1) 0;
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  white-space: pre-wrap;
}
</style>
