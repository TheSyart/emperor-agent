<script setup lang="ts">
import { useMarkdown } from '../../composables/useMarkdown'
import { handleMarkdownChipClick } from '../../composables/useMarkdownLinks'
import { toRef } from 'vue'

const props = defineProps<{ content: string; sourceMessageId?: string }>()
const { rendered } = useMarkdown(toRef(() => props.content))

function handleClick(event: MouseEvent): void {
  handleMarkdownChipClick(event, props.sourceMessageId || 'markdown')
}
</script>

<template>
  <div class="markdown-body" v-html="rendered" @click="handleClick" />
</template>
