<script setup lang="ts">
import { useMarkdown } from '../../composables/useMarkdown'
import { toRef } from 'vue'

const props = defineProps<{ content: string }>()
const { rendered } = useMarkdown(toRef(() => props.content))
</script>

<template>
  <div class="markdown-body" v-html="rendered" />
</template>
