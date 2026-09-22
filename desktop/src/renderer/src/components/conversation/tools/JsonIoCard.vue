<script setup lang="ts">
/**
 * JsonIoCard — generic IN/OUT card (dsh GenericToolCard body): IN as a
 * JsonTree when the arguments parse, else raw text; OUT as JsonTree for
 * JSON results, else text. Error OUT is danger-tinted.
 */
import { computed } from 'vue'
import JsonTree from '../../ui/JsonTree.vue'

const props = withDefaults(
  defineProps<{
    input?: unknown
    output?: unknown
    error?: boolean
    hasOutput?: boolean
  }>(),
  { input: undefined, output: undefined, error: false, hasOutput: false },
)

const isStructured = (value: unknown): boolean =>
  typeof value === 'object' && value !== null
const showInput = computed(
  () =>
    props.input !== undefined &&
    !(
      isStructured(props.input) &&
      Object.keys(props.input as object).length === 0
    ) &&
    props.input !== '',
)
const showOutput = computed(
  () => props.hasOutput && props.output !== undefined && props.output !== '',
)
</script>

<template>
  <div v-if="showInput || showOutput" class="io-card">
    <div v-if="showInput" class="section">
      <span class="label">IN</span>
      <div class="value">
        <JsonTree v-if="isStructured(input)" :value="input" :expand-depth="2" />
        <span v-else class="text">{{ input }}</span>
      </div>
    </div>
    <div v-if="showInput && showOutput" class="divider" />
    <div v-if="showOutput" class="section">
      <span class="label">OUT</span>
      <div class="value">
        <JsonTree
          v-if="isStructured(output) && !error"
          :value="output"
          :expand-depth="1"
        />
        <span v-else class="text" :data-error="error || undefined">{{
          typeof output === 'string' ? output : JSON.stringify(output, null, 2)
        }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.io-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
  font: var(--font-code-small);
}

.section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: var(--space-3-5);
  align-items: baseline;
  max-height: 220px;
  padding: var(--space-3) var(--space-4);
  overflow-y: auto;
}

.label {
  position: sticky;
  top: 0;
  align-self: start;
  color: rgb(var(--label-caption));
}

.divider {
  flex: none;
  height: 1px;
  background: var(--border-l2);
}

.value {
  min-width: 0;
}

.value :deep(.ds-json) {
  margin-left: calc(0px - var(--space-2-5));
}

.text {
  white-space: pre-wrap;
  word-break: break-word;
  color: rgb(var(--label-secondary));
}

.text[data-error] {
  color: rgb(var(--danger));
}
</style>
