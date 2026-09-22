<script setup lang="ts">
/** SkillView — loaded skill (name, source) with its instructions preview. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import Pill from '../../ui/Pill.vue'
import InOutCard from '../../ui/InOutCard.vue'
import { metaOf, resultText } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()
const meta = computed(() => metaOf(props.data))
</script>

<template>
  <div class="skill-view">
    <div v-if="meta" class="facts">
      <Pill>{{ meta.name }}</Pill>
      <span v-if="meta.source" class="source">{{ meta.source }}</span>
      <span v-if="meta.root" class="root">{{ meta.root }}</span>
    </div>
    <InOutCard
      v-if="data.result"
      :output="resultText(data)"
      :error="data.result.isError"
    />
  </div>
</template>

<style scoped>
.skill-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.facts {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.root {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--font-code-small);
}
</style>
