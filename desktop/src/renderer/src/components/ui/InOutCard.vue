<script setup lang="ts">
/**
 * InOutCard — dsh expanded tool body: IN / OUT sections with sticky caption
 * gutter labels, an l2 hairline between them, each section capped at 150px
 * (scrolls) with an expand toggle when the payload is long.
 *
 * Props:
 * - input?: string or any JSON value (pretty-printed).
 * - output?: string or any JSON value; omitted while the call runs.
 * - error?: tints OUT in the danger color.
 * - inLabel / outLabel (default 'IN' / 'OUT').
 */
import { computed, reactive } from 'vue'

const props = withDefaults(
  defineProps<{
    input?: unknown
    output?: unknown
    error?: boolean
    inLabel?: string
    outLabel?: string
  }>(),
  {
    input: undefined,
    output: undefined,
    error: false,
    inLabel: 'IN',
    outLabel: 'OUT',
  },
)

/** Lines past which a section offers "expand" instead of only scrolling. */
const LONG_LINES = 7

function show(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const sections = computed(() =>
  [
    { key: 'in' as const, label: props.inLabel, text: show(props.input) },
    { key: 'out' as const, label: props.outLabel, text: show(props.output) },
  ].filter((section) => section.text !== ''),
)

const expanded = reactive<Record<'in' | 'out', boolean>>({
  in: false,
  out: false,
})

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
          <div
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
  border-radius: var(--radius-sm);
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

.text-col {
  min-width: 0;
}

.text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: rgb(var(--label-secondary));
}

.text[data-error] {
  color: rgb(var(--danger));
}

.toggle {
  margin-top: var(--space-1);
  padding: 0;
  border: none;
  background: none;
  color: rgb(var(--label-tertiary));
  font: inherit;
  cursor: pointer;
}

.toggle:hover {
  color: rgb(var(--label-secondary));
}
</style>
