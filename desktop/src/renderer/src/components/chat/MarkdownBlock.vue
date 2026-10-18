<script setup lang="ts">
import { useMarkdown } from '../../composables/useMarkdown'
import {
  handleMarkdownClick,
  handleMarkdownKeydown,
} from '../../composables/useMarkdownLinks'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { inject, toRef } from 'vue'

const props = defineProps<{ content: string; sourceMessageId?: string }>()
const { rendered } = useMarkdown(toRef(() => props.content))
const app = inject(APP_CONTEXT_KEY, null)
const linkOptions = { notify: (message: string) => app?.showToast(message) }

function handleClick(event: MouseEvent): void {
  handleMarkdownClick(event, props.sourceMessageId || 'markdown', linkOptions)
}
</script>

<template>
  <div
    class="markdown-body"
    v-html="rendered"
    @click="handleClick"
    @keydown="handleMarkdownKeydown($event, linkOptions)"
  />
</template>
