<script setup lang="ts">
/**
 * TakeoverSeat — occupies the composer seat while a control interaction is
 * waiting and renders the matching dsh takeover card (see activeTakeover).
 * Cards talk to the app context directly; the seat emits nothing. Keyed by
 * interaction id so per-card drafts / latches never leak to the next one.
 */
import { computed } from 'vue'
import type { ControlInteraction } from '../../../types'
import AppTransition from '../../motion/AppTransition.vue'
import ApprovalPanel from './ApprovalPanel.vue'
import GrantPanel from './GrantPanel.vue'
import PlanReviewPanel from './PlanReviewPanel.vue'
import QuestionComposer from './QuestionComposer.vue'
import { activeTakeover } from './takeoverModel'

const props = defineProps<{ interaction: ControlInteraction | null }>()
const takeover = computed(() => activeTakeover(props.interaction))
</script>

<template>
  <AppTransition preset="materialize" origin="50% 100%" appear>
    <ApprovalPanel
      v-if="takeover?.kind === 'approval'"
      :key="`approval:${takeover.interaction.id}`"
      :interaction="takeover.interaction"
    />
    <GrantPanel
      v-else-if="takeover?.kind === 'grant'"
      :key="`grant:${takeover.interaction.id}`"
      :interaction="takeover.interaction"
    />
    <QuestionComposer
      v-else-if="takeover?.kind === 'question'"
      :key="`question:${takeover.interaction.id}`"
      :interaction="takeover.interaction"
    />
    <PlanReviewPanel
      v-else-if="takeover?.kind === 'plan'"
      :key="`plan:${takeover.interaction.id}`"
      :interaction="takeover.interaction"
    />
  </AppTransition>
</template>
