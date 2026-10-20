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
import {
  activeTakeover,
  isTakeoverMinimized,
  restoreTakeover,
  TAKEOVER_WAITING_LABEL,
} from './takeoverModel'

const props = defineProps<{ interaction: ControlInteraction | null }>()
const takeover = computed(() => activeTakeover(props.interaction))
/** Folded with Esc: one line above the composer until 展开. */
const folded = computed(() =>
  takeover.value ? isTakeoverMinimized(takeover.value.interaction.id) : false,
)
</script>

<template>
  <AppTransition preset="materialize" origin="50% 100%" appear>
    <div
      v-if="takeover && folded"
      :key="`folded:${takeover.interaction.id}`"
      class="takeover-folded"
      role="status"
    >
      <span class="takeover-folded-label">{{
        TAKEOVER_WAITING_LABEL[takeover.kind]
      }}</span>
      <button
        type="button"
        class="takeover-folded-action"
        @click="restoreTakeover(takeover.interaction.id)"
      >
        展开
      </button>
    </div>
    <ApprovalPanel
      v-else-if="takeover?.kind === 'approval'"
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

<style scoped>
.takeover-folded {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 780px;
  margin: 0 auto var(--space-1-5);
  padding: var(--space-1) var(--space-4);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.takeover-folded-label {
  flex: 1;
  min-width: 0;
}

.takeover-folded-action {
  flex: none;
  padding: var(--space-0-5) var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: rgb(var(--selector-fill));
  color: rgb(var(--text-1));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  cursor: pointer;
}

.takeover-folded-action:hover {
  background: rgb(var(--surface-hover-solid));
}
</style>
