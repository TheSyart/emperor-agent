<script setup lang="ts">
/** One prose segment of assistant markdown (useMarkdown + chip links). */
import { toRef } from 'vue'
import { useMarkdown } from '../../../composables/useMarkdown'
import { handleMarkdownChipClick } from '../../../composables/useMarkdownLinks'

const props = defineProps<{ text: string }>()
const { rendered } = useMarkdown(toRef(() => props.text))

function onClick(event: MouseEvent): void {
  handleMarkdownChipClick(event, 'conversation')
}
</script>

<template>
  <!-- sanitized by useMarkdown (DOMPurify) -->
  <div class="ds-md-html" @click="onClick" v-html="rendered" />
</template>
