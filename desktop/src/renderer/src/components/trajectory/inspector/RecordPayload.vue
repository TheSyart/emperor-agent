<script setup lang="ts">
/**
 * RecordPayload — Payload (tool arguments) / Result tab body: a JSON
 * container renders as a JsonTree, tool output blocks as text / images,
 * user / assistant text as markdown, anything else as preformatted text.
 * Errors render in the danger tone.
 *
 * Props: record; direction ('input' | 'output'); preview?.
 */
import { computed } from 'vue'
import type { TrajectoryLedgerRecord } from '../../../trajectory/model'
import JsonTree from '../../ui/JsonTree.vue'
import { parseJsonContainer } from '../trajectoryFormat'
import InspectorMarkdown from './InspectorMarkdown.vue'

const props = withDefaults(
  defineProps<{
    record: TrajectoryLedgerRecord
    direction: 'input' | 'output'
    preview?: boolean
  }>(),
  { preview: false },
)

const cell = computed(() => props.record.cell)
const value = computed(() =>
  props.direction === 'input'
    ? cell.value.inputDetail
    : cell.value.outputDetail,
)
const error = computed(
  () => props.direction === 'output' && cell.value.isError === true,
)
const json = computed(() =>
  value.value ? parseJsonContainer(value.value) : undefined,
)
const blocks = computed(() =>
  props.direction === 'output' &&
  cell.value.outputBlocks?.some(
    (block) => block.imageSrc !== undefined || block.content !== '',
  ) === true &&
  !(cell.value.outputBlocks.length === 1 && json.value !== undefined)
    ? cell.value.outputBlocks
    : undefined,
)
const markdown = computed(
  () =>
    (props.direction === 'input' &&
      (cell.value.kind === 'user' || cell.value.kind === 'context')) ||
    (props.direction === 'output' && cell.value.kind === 'message'),
)
</script>

<template>
  <p v-if="!value" class="no-payload">
    {{ direction === 'input' ? 'No payload captured' : 'No result captured' }}
  </p>
  <div
    v-else-if="json !== undefined"
    class="json"
    :data-error="error || undefined"
    data-inspector-json
  >
    <JsonTree :value="json" :expand-depth="preview ? 1 : 2" />
  </div>
  <div
    v-else-if="blocks !== undefined"
    class="blocks"
    :data-preview="preview || undefined"
    :data-error="error || undefined"
  >
    <template v-for="(block, index) in blocks" :key="index">
      <a
        v-if="block.imageSrc !== undefined"
        class="image-link"
        :href="block.imageSrc"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img class="image" :src="block.imageSrc" :alt="block.imageAlt ?? ''" />
      </a>
      <pre v-else-if="block.content !== ''" class="block-text">{{
        block.content
      }}</pre>
    </template>
  </div>
  <InspectorMarkdown
    v-else-if="markdown"
    :text="value"
    :preview="preview"
    :data-error="error || undefined"
  />
  <pre
    v-else
    class="payload"
    :data-preview="preview || undefined"
    :data-error="error || undefined"
    :data-empty="value === 'No output' || undefined"
    >{{ value }}</pre>
</template>

<style scoped>
.no-payload {
  margin: 0;
  padding: var(--space-4) var(--space-3-5);
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
}

.json[data-error='true'] :deep(*) {
  color: rgb(var(--danger));
}

.blocks {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  padding: var(--space-3-5);
}

.blocks[data-preview='true'] {
  gap: var(--space-1-5);
  padding: var(--space-1-5) var(--space-3-5) var(--space-2);
}

.block-text,
.payload {
  margin: 0;
  overflow-wrap: anywhere;
  color: rgb(var(--label-primary));
  font: 12px / 19px var(--font-mono);
  tab-size: 2;
  white-space: pre-wrap;
}

.payload {
  box-sizing: border-box;
  padding: var(--space-3-5);
  background: rgb(var(--code-block-bg));
}

.payload[data-preview='true'] {
  padding: var(--space-1-5) var(--space-3-5) var(--space-2);
}

[data-error='true'],
[data-error='true'] .block-text {
  color: rgb(var(--danger));
}

.payload[data-empty='true'] {
  color: rgb(var(--label-caption));
}

.image-link {
  display: block;
  max-width: 100%;
  overflow: hidden;
  border-radius: 2px;
  cursor: zoom-in;
}

.image {
  display: block;
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
}
</style>
