<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { ControlInteraction, ControlQuestion } from '../../types'
import { useAppContext } from '../../composables/useAppContext'
import {
  allAskQuestionsAnswered,
  askFreeformPresentation,
  askQuestionCanContinue,
  askSubmitLabel,
  ensureAskDraft,
  isProfileOnboardingAsk,
  toPlainAskAnswers,
  type AskAnswerDrafts,
} from './askInteractionModel'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()
const drafts = reactive<AskAnswerDrafts>({})
const currentIndex = reactive({ value: 0 })

const questions = computed(() => props.interaction.questions || [])
const total = computed(() => questions.value.length)
const currentQuestion = computed(
  () => questions.value[currentIndex.value] || null,
)
const currentDraft = computed(() =>
  currentQuestion.value
    ? ensureAskDraft(drafts, currentQuestion.value.id)
    : { choice: '', freeform: '' },
)
const submitLabel = computed(() =>
  askSubmitLabel(currentIndex.value, total.value),
)
const progressLabel = computed(
  () => `${Math.min(currentIndex.value + 1, total.value)} of ${total.value}`,
)
const isProfileOnboarding = computed(
  () =>
    isProfileOnboardingAsk(props.interaction) ||
    ctx.boot.value?.profileOnboarding?.interactionId === props.interaction.id,
)
const isPermission = computed(
  () => props.interaction.meta?.interaction_type === 'permission',
)
const canContinue = computed(() =>
  isPermission.value
    ? Boolean(currentDraft.value.choice?.trim())
    : askQuestionCanContinue(currentDraft.value),
)
const canSubmit = computed(() =>
  isPermission.value
    ? questions.value.every((question) =>
        Boolean(ensureAskDraft(drafts, question.id).choice?.trim()),
      )
    : allAskQuestionsAnswered(questions.value, drafts),
)
const freeformPresentation = computed(() =>
  currentQuestion.value
    ? askFreeformPresentation(isProfileOnboarding.value)
    : {
        label: '补充你的实际情况或其他说明（可选）',
        placeholder: '',
      },
)

watch(
  () => props.interaction.id,
  () => {
    for (const key of Object.keys(drafts)) delete drafts[key]
    currentIndex.value = 0
    for (const question of questions.value) {
      const draft = ensureAskDraft(drafts, question.id)
      const existing = props.interaction.answers?.[question.id]
      if (
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        draft.choice = String(
          (existing as Record<string, unknown>).choice || '',
        )
        draft.optionId = String(
          (existing as Record<string, unknown>).option_id ||
            (existing as Record<string, unknown>).optionId ||
            '',
        )
        draft.freeform = String(
          (existing as Record<string, unknown>).freeform || '',
        )
      }
    }
  },
  { immediate: true },
)

watch(total, (count) => {
  if (currentIndex.value >= count) currentIndex.value = Math.max(0, count - 1)
})

function choose(
  question: ControlQuestion,
  option: ControlQuestion['options'][number],
) {
  const draft = ensureAskDraft(drafts, question.id)
  if (draft.choice === option.label) {
    draft.choice = ''
    draft.optionId = ''
    return
  }
  draft.choice = option.label
  draft.optionId = option.id || ''
}

function move(delta: number) {
  const next = currentIndex.value + delta
  if (next < 0 || next >= total.value) return
  if (delta > 0 && !canContinue.value) return
  currentIndex.value = next
}

function submitOrNext() {
  if (!currentQuestion.value || !canContinue.value) return
  if (currentIndex.value < total.value - 1) {
    currentIndex.value += 1
    return
  }
  if (!canSubmit.value) return
  ctx.sendInteractionAnswer(
    props.interaction.id,
    toPlainAskAnswers(questions.value, drafts),
  )
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}

function skipPermanently() {
  void ctx.runSafely(() => ctx.skipProfileInterview())
}
</script>

<template>
  <section
    v-if="currentQuestion"
    class="active-ask-panel"
    @keydown.esc.prevent="cancel"
  >
    <header class="active-ask-head">
      <strong>{{ currentQuestion.question }}</strong>
      <div class="active-ask-counter">
        <button
          type="button"
          :disabled="currentIndex.value === 0"
          @click="move(-1)"
        >
          ‹
        </button>
        <span>{{ progressLabel }}</span>
        <button
          type="button"
          :disabled="currentIndex.value >= total - 1 || !canContinue"
          @click="move(1)"
        >
          ›
        </button>
      </div>
    </header>

    <div class="active-ask-options">
      <button
        v-for="(option, index) in currentQuestion.options"
        :key="option.label"
        type="button"
        class="active-ask-option"
        :data-active="currentDraft.choice === option.label"
        @click="choose(currentQuestion, option)"
      >
        <span class="active-ask-number">{{ index + 1 }}</span>
        <span class="active-ask-option-copy">
          <strong>{{ option.label }}</strong>
          <small>{{ option.description }}</small>
        </span>
      </button>
    </div>

    <label v-if="!isPermission" class="active-ask-freeform">
      <span>{{ freeformPresentation.label }}</span>
      <textarea
        v-model="currentDraft.freeform"
        rows="2"
        :placeholder="freeformPresentation.placeholder"
      />
    </label>

    <footer class="active-ask-actions">
      <button class="active-ask-ignore" type="button" @click="cancel">
        <span>{{ isProfileOnboarding ? '稍后再说' : '忽略' }}</span>
        <kbd>ESC</kbd>
      </button>
      <button
        v-if="isProfileOnboarding"
        class="active-ask-ignore"
        type="button"
        @click="skipPermanently"
      >
        不再提醒
      </button>
      <button
        class="active-ask-submit"
        type="button"
        :disabled="
          !canContinue || (currentIndex.value >= total - 1 && !canSubmit)
        "
        @click="submitOrNext"
      >
        {{ submitLabel }}
        <span aria-hidden="true">↩</span>
      </button>
    </footer>
  </section>
</template>
