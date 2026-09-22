<script setup lang="ts">
/**
 * RecordSchema — Schema tab: the tool's model-visible schema at call time
 * (name, description, parameters JsonTree), or its raw text.
 *
 * Props: record; preview?.
 */
import { computed } from 'vue'
import type { TrajectoryLedgerRecord } from '../../../trajectory/model'
import JsonTree from '../../ui/JsonTree.vue'
import { parseToolSchema } from '../trajectoryFormat'

const props = withDefaults(
  defineProps<{ record: TrajectoryLedgerRecord; preview?: boolean }>(),
  { preview: false },
)
const schema = computed(() =>
  props.record.cell.schemaDetail === undefined
    ? undefined
    : parseToolSchema(props.record.cell.schemaDetail),
)
</script>

<template>
  <p v-if="!record.cell.schemaDetail" class="no-payload">Schema unavailable</p>
  <div
    v-else-if="schema !== undefined"
    class="schema"
    :data-preview="preview || undefined"
  >
    <header class="intro">
      <h3 class="name">{{ schema.name }}</h3>
      <p v-if="schema.description !== ''" class="description">
        {{ schema.description }}
      </p>
    </header>
    <h4 class="parameters-title">Parameters</h4>
    <JsonTree :value="schema.parameters" :expand-depth="preview ? 1 : 3" />
  </div>
  <pre v-else class="payload">{{ record.cell.schemaDetail }}</pre>
</template>

<style scoped>
.no-payload {
  margin: 0;
  padding: var(--space-4) var(--space-3-5);
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
}

.intro {
  padding: var(--space-3) var(--space-3-5) var(--space-1-5);
}

.schema[data-preview='true'] .intro {
  padding-top: var(--space-1-5);
}

.name {
  margin: 0;
  color: rgb(var(--label-primary));
  font: 600 12px / 18px var(--font-mono);
}

.description {
  margin: 2px 0 0;
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  white-space: pre-wrap;
}

.schema[data-preview='true'] .description {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.parameters-title {
  margin: 0;
  padding: var(--space-1) var(--space-3-5) 2px;
  color: rgb(var(--label-tertiary));
  font: 600 11px / 16px var(--font-sans);
}

.payload {
  margin: 0;
  padding: var(--space-3-5);
  color: rgb(var(--label-primary));
  font: 12px / 19px var(--font-mono);
  white-space: pre-wrap;
}
</style>
