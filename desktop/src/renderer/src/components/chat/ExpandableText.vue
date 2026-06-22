<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{ text: string; limit?: number }>(), {
  limit: 180,
})

const expanded = ref(false)
const isLong = computed(() => props.text.length > props.limit)
const displayText = computed(() => {
  if (!isLong.value || expanded.value) return props.text
  return `${props.text.slice(0, props.limit).trimEnd()}...`
})
</script>

<template>
  <div class="expandable-text" :class="{ expanded }">
    <span>{{ displayText }}</span>
    <button v-if="isLong" type="button" @click="expanded = !expanded">
      {{ expanded ? '收起' : '展开' }}
    </button>
  </div>
</template>
