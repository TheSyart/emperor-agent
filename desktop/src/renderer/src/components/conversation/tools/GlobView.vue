<script setup lang="ts">
/** GlobView — matched paths through SearchBlock. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import IoBlock from '../../ui/IoBlock.vue'
import SearchBlock from '../../ui/SearchBlock.vue'
import { globCard, resultText } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const card = computed(() => globCard(props.data))
</script>

<template>
  <SearchBlock
    v-if="card"
    kind="paths"
    :paths="card.paths"
    :truncated="card.truncated"
    :total="card.total"
  />
  <IoBlock
    v-else-if="data.result"
    :output="resultText(data)"
    :error="data.result.isError"
  />
</template>
