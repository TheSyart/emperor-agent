<script setup lang="ts">
/**
 * IoBlock — the expanded tool body's IN / OUT block (UI-S03 merges the old
 * InOutCard and JsonIoCard): `--surface-raised`, r-md, no border; sticky
 * caption labels in a gutter, a hairline between the sections, each capped
 * at 150px (scrolls) with 「展开全部」 when long.
 *
 * Props:
 * - input?: string or any JSON value (an empty object or string is left out).
 * - output?: string or any JSON value; omitted while the call runs.
 * - error?: tints OUT in the error colour (and never shows it as a tree).
 * - tree?: show object values as a JsonTree instead of pretty-printed text
 *   (the generic body of unknown tools).
 * - inLabel / outLabel (default 'IN' / 'OUT').
 */
import { computed, reactive } from 'vue'
import JsonTree from './JsonTree.vue'

const props = withDefaults(
  defineProps<{
    input?: unknown
    output?: unknown
    error?: boolean
    tree?: boolean
    inLabel?: string
    outLabel?: string
  }>(),
  {
    input: undefined,
    output: undefined,
    error: false,
    tree: false,
    inLabel: 'IN',
    outLabel: 'OUT',
  },
)

/** Lines past which a section offers "expand" instead of only scrolling. */
const LONG_LINES = 7

type Key = 'in' | 'out'

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === '' ||
    (isObject(value) && Object.keys(value).length === 0)
  )
}

function show(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const sections = computed(() =>
  (
    [
      { key: 'in', label: props.inLabel, value: props.input },
      { key: 'out', label: props.outLabel, value: props.output },
    ] as const
  )
    .filter((section) => !empty(section.value))
    .map((section) => {
      const asTree =
        props.tree &&
        isObject(section.value) &&
        !(section.key === 'out' && props.error)
      return {
        ...section,
        asTree,
        text: show(section.value),
        depth: section.key === 'in' ? 2 : 1,
      }
    }),
)

const expanded = reactive<Record<Key, boolean>>({ in: false, out: false })

function isLong(text: string): boolean {
  return text.split('\n').length > LONG_LINES || text.length > 600
}
</script>

<template>
  <div v-if="sections.length" class="ds-io">
    <template v-for="(section, index) in sections" :key="section.key">
      <div v-if="index > 0" class="divider" />
      <div class="section" :data-expanded="expanded[section.key] || undefined">
        <span class="label">{{ section.label }}</span>
        <div class="text-col">
          <JsonTree
            v-if="section.asTree"
            class="tree"
            :value="section.value"
            :expand-depth="section.depth"
          />
          <div
            v-else
            class="text"
            :data-error="(section.key === 'out' && error) || undefined"
            v-text="section.text"
          />
          <button
            v-if="isLong(section.text)"
            type="button"
            class="toggle"
            :aria-expanded="expanded[section.key]"
            @click="expanded[section.key] = !expanded[section.key]"
          >
            {{ expanded[section.key] ? '收起' : '展开全部' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ds-io {
  display: flex;
  flex-direction: column;
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  font: var(--font-code-small);
}

.section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: var(--space-3-5);
  align-items: baseline;
  max-height: 150px;
  padding: var(--space-3) var(--space-4);
  overflow-y: auto;
}

.section[data-expanded] {
  max-height: none;
}

.section::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  background-clip: padding-box;
  border-radius: var(--r-sm);
}

.label {
  position: sticky;
  top: 0;
  align-self: start;
  color: rgb(var(--text-4));
}

.divider {
  flex: none;
  height: 0.5px;
  background: var(--hairline);
}

.text-col {
  min-width: 0;
}

.tree {
  margin-left: calc(0px - var(--space-2-5));
}

.text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: rgb(var(--text-2));
}

.text[data-error] {
  color: rgb(var(--error));
}

.toggle {
  margin-top: var(--space-1);
  padding: 0;
  border: none;
  background: none;
  color: rgb(var(--text-3));
  font: inherit;
  cursor: pointer;
}

.toggle:hover {
  color: rgb(var(--text-2));
}
</style>
