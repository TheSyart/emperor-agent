<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { ThoughtSegment } from '../../types'
import { thoughtPresentation, thoughtStatusLabel } from './thoughtDisplay'
import { CHAT_EXPANSION_STORE_KEY } from './expansionStoreKey'

const props = defineProps<{
  segment: ThoughtSegment
  executionDurationMs?: number
}>()

const expansion = inject(CHAT_EXPANSION_STORE_KEY, null)
const localOpen = ref<boolean | null>(null)

const presentation = computed(() =>
  thoughtPresentation(props.segment, props.executionDurationMs),
)
const summary = computed(() =>
  presentation.value.kind === 'summary' ? presentation.value.summary : '',
)
const hasSummary = computed(() => summary.value.length > 0)
const statusLabel = computed(() =>
  thoughtStatusLabel(props.segment, props.executionDurationMs),
)
const isRunning = computed(() => props.segment.status === 'running')
const isError = computed(
  () =>
    props.segment.status === 'error' ||
    props.segment.status === 'error_aborted',
)

const storeKey = computed(() => `thought:${props.segment.id}`)
// 默认:running 展开、终态收起;用户手动操作后不再被状态变化覆盖。
const isOpen = computed(() => {
  if (expansion) {
    // version 是 store 的唯一响应式源:读取它以订阅 setOpen 后的重算。
    void expansion.version.value
    return expansion.isOpen(storeKey.value, isRunning.value)
  }
  return localOpen.value ?? isRunning.value
})

function toggle() {
  if (expansion) {
    expansion.setOpen(storeKey.value, !isOpen.value)
  } else {
    localOpen.value = !isOpen.value
  }
}
</script>

<template>
  <!-- 无 summary:不可交互的单行状态 -->
  <div
    v-if="!hasSummary"
    class="timeline-node thought-status-node"
    :class="[props.segment.status]"
  >
    <span v-if="isRunning" class="thought-spinner" aria-hidden="true" />
    <span class="thought-status-label">{{ statusLabel }}</span>
  </div>

  <!-- 有 summary 且收起:单行按钮 -->
  <button
    v-else-if="!isOpen"
    type="button"
    class="timeline-node thought-collapsed"
    :class="[props.segment.status]"
    :aria-expanded="false"
    @click="toggle"
  >
    <span class="thought-state-icon" aria-hidden="true">{{
      isError ? '!' : '✓'
    }}</span>
    <span class="thought-collapsed-label">{{ statusLabel }}</span>
    <span class="thought-chevron" aria-hidden="true">›</span>
  </button>

  <!-- 有 summary 且展开:引述块 -->
  <div
    v-else
    class="timeline-node thought-quote"
    :class="[props.segment.status]"
  >
    <button
      type="button"
      class="thought-quote-head"
      :aria-expanded="true"
      @click="toggle"
    >
      <span v-if="isRunning" class="thought-spinner" aria-hidden="true" />
      <span v-else class="thought-state-icon" aria-hidden="true">{{
        isError ? '!' : '✓'
      }}</span>
      <span>{{ isRunning ? '思考中…' : statusLabel }}</span>
      <span class="thought-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="thought-quote-body">
      {{ summary
      }}<span v-if="isRunning" class="thought-live-cursor" aria-hidden="true" />
    </div>
  </div>
</template>
