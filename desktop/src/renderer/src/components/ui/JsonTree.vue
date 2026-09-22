<script setup lang="ts">
/**
 * JsonTree — DevTools-style collapsible JSON viewer (dsh JsonTree look).
 *
 * Props:
 * - value: any JSON-compatible value.
 * - name?: property label for this node (omitted at the root).
 * - depth (internal, default 0).
 * - expandDepth (default 1): nodes shallower than this start expanded.
 */
import { computed, ref } from 'vue'
import {
  jsonEntries,
  jsonKind,
  jsonPreview,
  formatJsonPrimitive,
} from './jsonTree'

const props = withDefaults(
  defineProps<{
    value: unknown
    name?: string
    depth?: number
    expandDepth?: number
  }>(),
  { name: undefined, depth: 0, expandDepth: 1 },
)

const kind = computed(() => jsonKind(props.value))
const expandable = computed(
  () =>
    (kind.value === 'object' || kind.value === 'array') &&
    jsonEntries(props.value).length > 0,
)
const open = ref(props.depth < props.expandDepth)
const entries = computed(() => (open.value ? jsonEntries(props.value) : []))
const indent = computed(() => ({
  paddingLeft: `calc(${props.depth} * var(--space-3) + var(--space-2-5))`,
}))
const brackets = computed(() =>
  kind.value === 'array' ? (['[', ']'] as const) : (['{', '}'] as const),
)
</script>

<template>
  <div class="ds-json" :data-root="depth === 0 || undefined">
    <div class="row" :style="indent">
      <button
        v-if="expandable"
        type="button"
        class="expander"
        :style="{ left: `calc(${depth} * var(--space-3))` }"
        :data-open="open || undefined"
        :aria-expanded="open"
        :aria-label="open ? 'Collapse JSON node' : 'Expand JSON node'"
        @click="open = !open"
      />
      <span v-if="name !== undefined" class="label">{{ name }}:</span>
      <template v-if="kind === 'object' || kind === 'array'">
        <span v-if="open && expandable" class="punct">{{ brackets[0] }}</span>
        <span
          v-else
          class="preview"
          @click="expandable ? (open = !open) : undefined"
          >{{ jsonPreview(value) }}</span
        >
      </template>
      <span v-else :class="['value', `value--${kind}`]">{{
        formatJsonPrimitive(value)
      }}</span>
    </div>
    <template v-if="open && expandable">
      <JsonTree
        v-for="[key, child] in entries"
        :key="key"
        :name="key"
        :value="child"
        :depth="depth + 1"
        :expand-depth="expandDepth"
      />
      <div class="row" :style="indent">
        <span class="punct">{{ brackets[1] }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ds-json {
  min-width: 0;
  font: var(--font-code-small);
  color: rgb(var(--label-primary));
}

.ds-json[data-root] {
  overflow: auto;
  padding: var(--space-1-5) var(--space-2) var(--space-2);
  white-space: pre;
}

.row {
  position: relative;
  min-height: var(--space-4);
}

.row:hover {
  background: var(--interactive-bg-hover);
}

.expander {
  position: absolute;
  top: 0;
  display: inline-flex;
  align-items: center;
  width: var(--space-2);
  height: var(--space-4);
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.expander::before {
  content: '';
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent currentColor;
  transform: scale(0.75);
  transform-origin: 33.333% center;
  transition: transform var(--duration-ds-fast) ease;
}

.expander[data-open]::before {
  transform: rotate(90deg) scale(0.75);
}

.expander:hover {
  color: rgb(var(--label-primary));
}

.label {
  margin-right: var(--space-1);
  color: rgb(var(--code-function));
}

.punct,
.preview {
  color: rgb(var(--code-punctuation));
}

.preview {
  cursor: pointer;
}

.value--string {
  color: rgb(var(--code-string));
  white-space: pre-wrap;
  word-break: break-word;
}

.value--number,
.value--boolean,
.value--null {
  color: rgb(var(--code-constant));
}

.value--other {
  color: rgb(var(--label-secondary));
}
</style>
