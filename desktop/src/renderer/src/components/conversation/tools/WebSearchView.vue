<script setup lang="ts">
/** WebSearchView — answer + source citations through WebBlock. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import InOutCard from '../../ui/InOutCard.vue'
import WebBlock from '../../ui/WebBlock.vue'
import { resultText, webCard } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const card = computed(() => webCard(props.data))
</script>

<template>
  <WebBlock
    v-if="card"
    kind="search"
    :answer="card.answer"
    :sources="card.sources"
    :truncated="card.truncated"
  />
  <InOutCard
    v-else-if="data.result"
    :output="resultText(data)"
    :error="data.result.isError"
  />
</template>
