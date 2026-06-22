<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { ControlInteraction } from '../../types'
import { useAppContext } from '../../composables/useAppContext'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()
const answers = reactive<Record<string, { choice: string; freeform: string }>>({})

const questions = computed(() => props.interaction.questions || [])
const waiting = computed(() => props.interaction.status === 'waiting')
const canSubmit = computed(() =>
  waiting.value &&
  questions.value.length > 0 &&
  questions.value.every((q) => {
    const answer = answers[q.id]
    return Boolean(answer?.choice || answer?.freeform?.trim())
  }),
)

function ensure(id: string) {
  answers[id] ||= { choice: '', freeform: '' }
  return answers[id]
}

function choose(id: string, label: string) {
  ensure(id).choice = label
}

function submit() {
  if (!canSubmit.value) return
  ctx.sendInteractionAnswer(props.interaction.id, answers)
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}
</script>

<template>
  <section class="control-card ask-card" :class="props.interaction.status">
    <header class="control-card-head">
      <span>需要定夺</span>
      <strong>澄清问题</strong>
      <em>{{ props.interaction.status }}</em>
    </header>
    <p v-if="props.interaction.context" class="control-context">{{ props.interaction.context }}</p>

    <div class="ask-question-list">
      <article v-for="question in questions" :key="question.id" class="ask-question">
        <div class="ask-question-title">
          <span>{{ question.header }}</span>
          <strong>{{ question.question }}</strong>
        </div>
        <div class="ask-options">
          <button
            v-for="option in question.options"
            :key="option.label"
            type="button"
            :disabled="!waiting"
            :data-active="ensure(question.id).choice === option.label"
            @click="choose(question.id, option.label)"
          >
            <strong>{{ option.label }}</strong>
            <small>{{ option.description }}</small>
          </button>
        </div>
        <textarea
          v-model="ensure(question.id).freeform"
          :disabled="!waiting"
          rows="2"
          placeholder="补充说明，可替代选项"
        />
      </article>
    </div>

    <footer v-if="waiting" class="control-actions">
      <button class="control-secondary" type="button" @click="cancel">取消</button>
      <button class="control-primary" type="button" :disabled="!canSubmit" @click="submit">提交回答</button>
    </footer>
    <footer v-else class="control-footnote">此问题已处理。</footer>
  </section>
</template>
