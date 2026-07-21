<script setup lang="ts">
import { computed } from 'vue'
import type { ControlInteraction } from '../../types'
import { askHistoryPresentation } from './askInteractionModel'

const props = defineProps<{ interaction: ControlInteraction }>()
const presentation = computed(() => askHistoryPresentation(props.interaction))
</script>

<template>
  <section
    class="ask-history-card"
    :data-tone="presentation.tone"
    :data-interaction-type="props.interaction.meta?.interaction_type || 'ask'"
  >
    <div class="ask-history-main">
      <span class="ask-history-dot" />
      <div class="min-w-0">
        <div class="ask-history-title">{{ presentation.title }}</div>
        <div v-if="presentation.detail" class="ask-history-detail">
          {{ presentation.detail }}
        </div>
      </div>
    </div>
    <span class="ask-history-status">{{ presentation.status }}</span>
    <div v-if="presentation.answers.length" class="ask-history-answers">
      <div
        v-for="answer in presentation.answers"
        :key="answer.header"
        class="ask-history-answer"
      >
        <span>{{ answer.header }}</span>
        <strong>{{ answer.value }}</strong>
      </div>
    </div>
  </section>
</template>
