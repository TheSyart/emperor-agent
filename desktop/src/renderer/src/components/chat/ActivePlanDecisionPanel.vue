<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ControlInteraction } from '../../types'
import { useAppContext } from '../../composables/useAppContext'
import { planDecisionVisible } from './planDisplay'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()
const comment = ref('')

const visible = computed(() => planDecisionVisible(props.interaction))
const canSubmit = computed(() => visible.value)

function submit() {
  if (!canSubmit.value) return
  const text = comment.value.trim()
  const ok = text
    ? ctx.sendPlanComment(props.interaction.id, text)
    : ctx.approvePlan(props.interaction.id)
  if (ok) comment.value = ''
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}
</script>

<template>
  <section v-if="visible" class="active-plan-decision-panel" @keydown.esc.prevent="cancel">
    <header class="active-plan-decision-head">
      <strong>实施此计划？</strong>
    </header>

    <button type="button" class="active-plan-decision-option" :data-active="!comment.trim()" @click="comment = ''">
      <span class="active-ask-number">1</span>
      <span class="active-plan-decision-copy">
        <strong>是，实施此计划</strong>
      </span>
    </button>

    <label class="active-plan-decision-option active-plan-decision-freeform" :data-active="Boolean(comment.trim())">
      <span class="active-ask-number">2</span>
      <textarea
        v-model="comment"
        rows="1"
        placeholder="否，请告诉emperor如何调整"
      />
    </label>

    <footer class="active-plan-decision-actions">
      <button class="active-ask-ignore" type="button" @click="cancel">
        <span>忽略</span>
        <kbd>ESC</kbd>
      </button>
      <button class="active-ask-submit" type="button" :disabled="!canSubmit" @click="submit">
        提交
        <span aria-hidden="true">↩</span>
      </button>
    </footer>
  </section>
</template>
