<script setup lang="ts">
import { FileDiff } from 'lucide-vue-next'
import type { TurnChangeSnapshot } from '../../types'
import { turnChangesStatusText } from './turnChangesModel'

defineProps<{
  snapshot: TurnChangeSnapshot
  stepLabel?: string
}>()
const emit = defineEmits<{ openReview: [] }>()
</script>

<template>
  <button
    type="button"
    class="turn-changes-status"
    aria-label="在 Review 中查看本次任务变更"
    @click="emit('openReview')"
  >
    <FileDiff :size="14" aria-hidden="true" />
    <span v-if="stepLabel">{{ stepLabel }} · </span>
    <span>{{ turnChangesStatusText(snapshot) }}</span>
  </button>
</template>
