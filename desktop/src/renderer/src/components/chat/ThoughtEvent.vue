<script setup lang="ts">
import { computed } from 'vue'
import type { ThoughtSegment } from '../../types'

const props = defineProps<{ segment: ThoughtSegment }>()

const label = computed(() => {
  const phase = props.segment.label || '思考'
  if (props.segment.status === 'running') return phase
  if (props.segment.status === 'error' || props.segment.status === 'error_aborted') return `${phase}已中断`
  return `${phase} · ${durationLabel(props.segment.durationMs)}`
})

function durationLabel(ms?: number) {
  if (!ms && ms !== 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
</script>

<template>
  <div class="timeline-node thought-node" :class="props.segment.status">
    <span class="thought-label">{{ label }}</span>
    <span class="thought-chevron" aria-hidden="true">›</span>
  </div>
</template>
