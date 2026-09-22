<script setup lang="ts">
/** ReadView — the returned file window through ReadBlock (IN/OUT fallback). */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import InOutCard from '../../ui/InOutCard.vue'
import ReadBlock from '../../ui/ReadBlock.vue'
import { readWindow, resultText, shortPath } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const readWin = computed(() => readWindow(props.data))
</script>

<template>
  <ReadBlock
    v-if="readWin && readWin.lines.length"
    :lines="readWin.lines"
    :total-lines="readWin.totalLines"
    :label="shortPath(readWin.path)"
    :max-lines="24"
  />
  <InOutCard
    v-else-if="data.result"
    :output="resultText(data)"
    :error="data.result.isError"
  />
</template>
