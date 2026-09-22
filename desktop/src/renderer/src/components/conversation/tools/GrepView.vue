<script setup lang="ts">
/** GrepView — grouped matches through SearchBlock plus the recovery note. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import InOutCard from '../../ui/InOutCard.vue'
import SearchBlock from '../../ui/SearchBlock.vue'
import { grepCard, resultText } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const card = computed(() => grepCard(props.data))
</script>

<template>
  <template v-if="card">
    <SearchBlock
      kind="matches"
      :files="card.files"
      :truncated="card.truncated"
      :total="card.total"
    />
    <div v-if="card.recovery" class="recovery">{{ card.recovery }}</div>
  </template>
  <InOutCard
    v-else-if="data.result"
    :output="resultText(data)"
    :error="data.result.isError"
  />
</template>

<style scoped>
.recovery {
  margin-top: var(--space-1);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
