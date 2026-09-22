<script setup lang="ts">
/** DiffView — write / edit / memory_edit change through DiffBlock. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import DiffBlock from '../../ui/DiffBlock.vue'
import InOutCard from '../../ui/InOutCard.vue'
import { mutationHunks, resultText } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const hunks = computed(() => mutationHunks(props.data))
</script>

<template>
  <DiffBlock v-if="hunks && hunks.length" :diffs="hunks" :max-lines="24" />
  <InOutCard
    v-else-if="data.result"
    :output="resultText(data)"
    :error="data.result.isError"
  />
</template>
