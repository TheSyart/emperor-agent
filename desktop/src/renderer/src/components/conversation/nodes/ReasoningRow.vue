<script setup lang="ts">
/**
 * ReasoningRow — dsh Think disclosure: `思考 · {summary}`, collapsed by
 * default. While streaming the summary is the latest non-blank line kept
 * scrolled to its end (glare sweep on the row); settled, the first line.
 * Expanded body: 14/24 tertiary pre-wrap.
 *
 * Props: text, running, expansionKey (survives virtual unmounts).
 */
import { computed, nextTick, ref, watch } from 'vue'
import { DsThink } from '../../icons/ds'
import DisclosureRow from '../../ui/DisclosureRow.vue'
import { useExpansion } from '../chatContext'

const props = defineProps<{
  text: string
  running: boolean
  expansionKey: string
}>()

const open = useExpansion(() => props.expansionKey)
const summaryEl = ref<HTMLElement | null>(null)

function firstLine(text: string): string {
  const trimmed = text.trimStart()
  const newline = trimmed.indexOf('\n')
  return newline === -1 ? trimmed : trimmed.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

const summary = computed(() =>
  props.running ? latestLine(props.text) : firstLine(props.text),
)

let scheduled = false
watch(
  [summary, () => props.running],
  () => {
    if (scheduled) return
    scheduled = true
    void nextTick(() => {
      scheduled = false
      const el = summaryEl.value
      if (el === null) return
      el.scrollLeft = props.running ? el.scrollWidth - el.clientWidth : 0
    })
  },
  { immediate: true },
)
</script>

<template>
  <div class="reasoning" :data-state="running ? 'running' : 'ok'">
    <span v-if="running" class="sr-only">思考中</span>
    <DisclosureRow v-model:open="open" title="思考" :running="running">
      <template #icon><DsThink :size="14" /></template>
      <template v-if="summary" #summary>
        <span
          ref="summaryEl"
          class="summary-text"
          :data-follow-end="running || undefined"
          >{{ summary }}</span
        >
      </template>
      <div class="think-body">{{ text }}</div>
    </DisclosureRow>
  </div>
</template>

<style scoped>
.reasoning {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.reasoning :deep(.title) {
  color: rgb(var(--label-secondary));
}

.summary-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-text[data-follow-end] {
  text-overflow: clip;
}

.think-body {
  padding: var(--space-1) 0;
  font-size: var(--fs-s);
  line-height: var(--lh-base);
  color: rgb(var(--label-tertiary));
  white-space: pre-wrap;
  word-break: break-word;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
