<script setup lang="ts">
/** GenericToolCard — fallback body: arguments IN / result OUT (JsonTree). */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import IoBlock from '../../ui/IoBlock.vue'
import { parseToolArgs, resultValue } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const input = computed(
  () => parseToolArgs(props.data.argsRaw) ?? props.data.argsRaw,
)
const output = computed(() =>
  props.data.result === undefined ? undefined : resultValue(props.data),
)
</script>

<template>
  <IoBlock
    :input="input"
    :output="output"
    :error="data.result?.isError === true"
    tree
  />
</template>
