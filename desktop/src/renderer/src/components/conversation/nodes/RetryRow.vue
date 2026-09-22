<script setup lang="ts">
/**
 * RetryRow — dsh model-retry disclosure: one 13/20 tertiary summary line
 * (`请求失败，3 秒后重试 · 第 1/3 次`) with a shimmer while the retry is
 * scheduled; the details reveal the delay and the failure.
 *
 * Props: node (retry). The countdown anchors to this row's first render
 * (host and browser clocks may differ).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { RetryChatNode } from '../../../conversation/types'
import { useExpansion } from '../chatContext'

const props = defineProps<{ node: RetryChatNode }>()
const open = useExpansion(() => `${props.node.key}:details`)

const current = computed(() => props.node.data.current)
const active = computed(() => current.value.state === 'scheduled')

const deadline = ref(Date.now() + current.value.delayMs)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

watch(
  () => [current.value.seq, active.value] as const,
  ([, isActive], previous) => {
    if (previous === undefined || previous[0] !== current.value.seq)
      deadline.value = Date.now() + current.value.delayMs
    clearInterval(timer)
    timer = undefined
    now.value = Date.now()
    if (isActive)
      timer = setInterval(() => {
        now.value = Date.now()
        if (deadline.value - now.value <= 1000) clearInterval(timer)
      }, 250)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(timer))

const seconds = computed(() =>
  Math.max(
    1,
    Math.ceil(
      (active.value ? deadline.value - now.value : current.value.delayMs) /
        1000,
    ),
  ),
)
const maximum = computed(() => current.value.maxRetries ?? '∞')
const label = computed(() => {
  if (active.value) return `请求失败，${seconds.value} 秒后重试`
  if (current.value.state === 'cancelled') return '重试已取消'
  return '请求失败，已重试'
})
</script>

<template>
  <div class="retry" :data-active="active || undefined">
    <button
      type="button"
      class="summary"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        class="text"
        :class="{ 'ds-shimmer': active }"
        data-tone="neutral"
        role="status"
        >{{ label }} · 第 {{ current.retry }}/{{ maximum }} 次</span
      >
      <span class="chevron" :data-open="open || undefined" aria-hidden="true" />
    </button>
    <div v-if="open" class="details">
      <div>
        <span class="label">延迟</span>{{ Math.round(current.delayMs) }}ms
      </div>
      <div>
        <span class="label">失败原因</span>{{ current.message }}
        <code v-if="current.code" class="code">{{ current.code }}</code>
      </div>
      <div v-if="node.data.attempts.length > 1">
        <span class="label">累计</span>{{ node.data.attempts.length }} 次重试 ·
        {{ current.provider }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.retry {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.summary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-0-5) 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.summary:hover {
  color: rgb(var(--label-secondary));
}

.summary:focus-visible {
  outline: 1.5px solid rgb(var(--focus-ring));
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

.chevron {
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  opacity: 0.8;
  transform: rotate(-45deg);
  transition: transform var(--duration-fast) ease;
}

.chevron[data-open] {
  transform: rotate(45deg);
}

.details {
  display: grid;
  gap: var(--space-0-5);
  margin-top: var(--space-1);
  padding-left: var(--space-3-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}

.label {
  margin-right: var(--space-1-5);
  color: rgb(var(--label-secondary));
}

.code {
  margin-left: var(--space-1-5);
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
}
</style>
