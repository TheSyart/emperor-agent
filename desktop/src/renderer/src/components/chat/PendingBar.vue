<script setup lang="ts">
import { computed } from 'vue'
import type { PendingState } from '../../types'

const props = defineProps<{ pending: PendingState }>()

const toneLabel = computed(() => {
  if (props.pending.tone === 'error') return '异常'
  if (props.pending.tone === 'done') return '回禀'
  return '进行中'
})
</script>

<template>
  <div v-if="props.pending.label" class="pending-bar" :class="props.pending.tone || 'running'">
    <span class="pending-seal">
      <span class="pending-dot" />
    </span>
    <div class="min-w-0 flex-1">
      <div class="pending-title">{{ props.pending.label }}</div>
      <div v-if="props.pending.detail" class="pending-detail">{{ props.pending.detail }}</div>
    </div>
    <span class="pending-label">{{ toneLabel }}</span>
  </div>
</template>
