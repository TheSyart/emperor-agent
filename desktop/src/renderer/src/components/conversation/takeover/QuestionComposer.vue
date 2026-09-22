<script setup lang="ts">
/**
 * QuestionComposer — dsh composer takeover for a pending `ask_user_question`
 * (non-permission ask). One question per page: numbered options (checkboxes
 * for multi_select), an inline free-form "其他" row, a pager when there is
 * more than one question, and ignore / continue actions. The profile
 * onboarding ask swaps "忽略" for "稍后再说" and adds "不再提醒".
 *
 * Keyboard: 1-9 pick an option (outside the text field), Enter continues or
 * submits, Shift+Enter breaks a line in the text field, Esc cancels.
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import type { ControlInteraction, ControlQuestion } from '../../../types'
import { useAppContext } from '../../../composables/useAppContext'
import Button from '../../ui/Button.vue'
import IconButton from '../../ui/IconButton.vue'
import {
  DsCheck,
  DsChevronDown,
  DsChevronLeft,
  DsChevronRight,
  DsChevronUp,
  DsClose,
  DsEdit,
} from '../../icons/ds'
import {
  allAskQuestionsAnswered,
  askFreeformPresentation,
  askOptionActive,
  askQuestionCanContinue,
  askSubmitLabel,
  ensureAskDraft,
  isProfileOnboardingAsk,
  seedAskDrafts,
  toggleAskOption,
  toPlainAskAnswers,
  type AskAnswerDraft,
  type AskAnswerDrafts,
} from './questionModel'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()

const drafts = reactive<AskAnswerDrafts>({})
const index = ref(0)
const busy = ref(false)
const minimized = ref(false)
const root = ref<HTMLElement | null>(null)

const questions = computed(() => props.interaction.questions || [])
const total = computed(() => questions.value.length)
const question = computed<ControlQuestion | null>(
  () => questions.value[index.value] || null,
)
const draft = computed<AskAnswerDraft>(() =>
  question.value
    ? ensureAskDraft(drafts, question.value.id)
    : { choice: '', freeform: '' },
)
const hasOptions = computed(() => (question.value?.options.length || 0) > 0)
const multi = computed(() => question.value?.multi_select === true)
const isLast = computed(() => index.value >= total.value - 1)
const canContinue = computed(() => askQuestionCanContinue(draft.value))
const canSubmit = computed(() =>
  allAskQuestionsAnswered(questions.value, drafts),
)
const primaryDisabled = computed(
  () => busy.value || !canContinue.value || (isLast.value && !canSubmit.value),
)
const submitLabel = computed(() => askSubmitLabel(index.value, total.value))
const isProfileOnboarding = computed(
  () =>
    isProfileOnboardingAsk(props.interaction) ||
    ctx.boot.value?.profileOnboarding?.interactionId === props.interaction.id,
)
const freeform = computed(() =>
  askFreeformPresentation(isProfileOnboarding.value),
)
const mirror = computed(() => `${draft.value.freeform || ''}\n`)
const titleId = computed(
  () => `takeover-question-${props.interaction.id}-${index.value}`,
)

watch(
  () => props.interaction.id,
  () => {
    seedAskDrafts(drafts, props.interaction)
    index.value = 0
    busy.value = false
  },
  { immediate: true },
)

watch(total, (count) => {
  if (index.value >= count) index.value = Math.max(0, count - 1)
})

onMounted(() => {
  // Take keyboard focus so number keys / Enter / Esc work without a click;
  // an optionless question focuses its own text field instead.
  void nextTick(() => {
    const field =
      root.value?.querySelector<HTMLTextAreaElement>('[data-autofocus]')
    ;(field || root.value)?.focus({ preventScroll: true })
  })
})

function choose(option: ControlQuestion['options'][number]) {
  if (!question.value || busy.value) return
  toggleAskOption(draft.value, question.value, option)
}

function go(delta: number) {
  const next = index.value + delta
  if (next < 0 || next >= total.value) return
  if (delta > 0 && !canContinue.value) return
  index.value = next
}

function submitOrNext() {
  if (!question.value || busy.value || !canContinue.value) return
  if (!isLast.value) {
    index.value += 1
    return
  }
  if (!canSubmit.value) return
  busy.value = true
  const ok = ctx.sendInteractionAnswer(
    props.interaction.id,
    toPlainAskAnswers(questions.value, drafts),
  )
  if (!ok) busy.value = false
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}

function skipPermanently() {
  void ctx.runSafely(() => ctx.skipProfileInterview())
}

function onInput(event: Event) {
  draft.value.freeform = (event.target as HTMLTextAreaElement).value
}

function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
    return
  }
  const target = event.target as HTMLElement | null
  const inField = target?.tagName === 'TEXTAREA'
  if (event.key === 'Enter') {
    if (event.shiftKey || isComposing(event)) return
    // A focused button handles Enter itself (native click).
    if (!inField && target?.tagName === 'BUTTON') return
    event.preventDefault()
    submitOrNext()
    return
  }
  if (inField || event.metaKey || event.ctrlKey || event.altKey) return
  if (/^[1-9]$/.test(event.key) && question.value) {
    const option = question.value.options[Number(event.key) - 1]
    if (!option) return
    event.preventDefault()
    choose(option)
  }
}
</script>

<template>
  <div class="frame" data-takeover="question">
    <section
      v-if="question"
      ref="root"
      class="card"
      :data-minimized="minimized || undefined"
      :aria-labelledby="titleId"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="header">
        <div class="heading">
          <div v-if="question.header || multi" class="eyebrow">
            {{ question.header }}
            <span v-if="multi" class="hint">{{
              question.header ? '· 可多选' : '可多选'
            }}</span>
          </div>
          <h2 :id="titleId" class="title">{{ question.question }}</h2>
        </div>
        <div class="header-actions">
          <IconButton
            :label="minimized ? '展开' : '收起'"
            round
            class="small-icon"
            :disabled="busy"
            :aria-expanded="!minimized"
            @click="minimized = !minimized"
          >
            <DsChevronUp v-if="minimized" :size="14" />
            <DsChevronDown v-else :size="14" />
          </IconButton>
          <IconButton
            :label="isProfileOnboarding ? '稍后再说' : '忽略'"
            round
            class="small-icon"
            :disabled="busy"
            @click="cancel"
          >
            <DsClose :size="14" />
          </IconButton>
        </div>
      </header>

      <template v-if="!minimized">
        <div class="body">
          <div
            class="options"
            :role="multi ? 'group' : 'radiogroup'"
            :aria-labelledby="titleId"
          >
            <button
              v-for="(option, optionIndex) in question.options"
              :key="`${option.label}-${optionIndex}`"
              type="button"
              class="option"
              :data-selected="
                (!multi && askOptionActive(draft, question, option)) ||
                undefined
              "
              :role="multi ? 'checkbox' : 'radio'"
              :aria-checked="askOptionActive(draft, question, option)"
              :disabled="busy"
              @click="choose(option)"
            >
              <span
                v-if="multi"
                class="checkbox"
                :data-checked="
                  askOptionActive(draft, question, option) || undefined
                "
                aria-hidden="true"
              >
                <DsCheck
                  v-if="askOptionActive(draft, question, option)"
                  :size="12"
                />
              </span>
              <span v-else class="number">{{ optionIndex + 1 }}</span>
              <span class="option-line">
                <span class="option-label">{{ option.label }}</span>
                <span v-if="option.description" class="description">{{
                  option.description
                }}</span>
              </span>
            </button>

            <div
              v-if="hasOptions"
              class="custom-row"
              :data-active="Boolean(draft.freeform?.trim()) || undefined"
            >
              <span class="number" aria-hidden="true">
                <DsEdit :size="12" />
              </span>
              <div class="field">
                <div class="field-mirror" aria-hidden="true" v-text="mirror" />
                <textarea
                  class="field-input"
                  rows="1"
                  :value="draft.freeform"
                  :placeholder="freeform.label"
                  :aria-label="freeform.label"
                  :title="freeform.placeholder"
                  :disabled="busy"
                  @input="onInput"
                />
              </div>
            </div>
          </div>

          <div v-if="!hasOptions" class="field field-block">
            <div class="field-mirror" aria-hidden="true" v-text="mirror" />
            <textarea
              class="field-input"
              rows="1"
              data-autofocus
              :value="draft.freeform"
              :placeholder="freeform.placeholder || freeform.label"
              :aria-label="freeform.label"
              :disabled="busy"
              @input="onInput"
            />
          </div>
        </div>

        <footer class="footer">
          <div v-if="total > 1" class="pager">
            <IconButton
              label="上一题"
              round
              class="small-icon"
              :disabled="index === 0 || busy"
              @click="go(-1)"
            >
              <DsChevronLeft :size="14" />
            </IconButton>
            <span class="progress">{{ index + 1 }} / {{ total }}</span>
            <IconButton
              label="下一题"
              round
              class="small-icon"
              :disabled="isLast || !canContinue || busy"
              @click="go(1)"
            >
              <DsChevronRight :size="14" />
            </IconButton>
          </div>
          <span v-else />
          <div class="footer-actions">
            <Button variant="ghost" :disabled="busy" @click="cancel">
              {{ isProfileOnboarding ? '稍后再说' : '忽略' }}
              <kbd class="kbd">Esc</kbd>
            </Button>
            <Button
              v-if="isProfileOnboarding"
              variant="ghost"
              :disabled="busy"
              @click="skipPermanently"
            >
              不再提醒
            </Button>
            <Button
              variant="primary"
              data-action="submit"
              :disabled="primaryDisabled"
              @click="submitOrNext"
            >
              {{ submitLabel }}
            </Button>
          </div>
        </footer>
      </template>
    </section>
  </div>
</template>

<style scoped>
.frame {
  display: flex;
  justify-content: center;
  padding: var(--space-1-5) calc(var(--composer-side-clearance, 16px) + 16px)
    var(--space-2-5);
}

.card {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: var(--chat-content-width, 748px);
  max-height: min(60vh, 520px);
  padding: 0 0 var(--space-2-5);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-takeover);
  background: rgb(var(--input-major));
  box-shadow: var(--shadow-lv2);
  color: rgb(var(--label-primary));
  overflow: hidden;
  outline: none;
}

.card,
.card * {
  box-sizing: border-box;
}

.card[data-minimized] {
  max-height: none;
}

.card[data-minimized] .header {
  padding-bottom: var(--space-3-5);
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-shrink: 0;
  padding: var(--space-5) var(--space-4) 0 var(--space-6);
}

.heading {
  min-width: 0;
}

.eyebrow {
  margin-bottom: calc(var(--space-1) + 1px);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxxs);
  line-height: 16px;
}

.title {
  margin: 0;
  font-size: var(--fs-base);
  line-height: 22px;
  font-weight: 500;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

.header-actions .small-icon,
.pager .small-icon {
  width: 24px;
  height: 24px;
  color: rgb(var(--label-tertiary));
}

.body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: var(--space-2) 0 0;
  padding: var(--space-1) var(--space-3);
}

.option,
.custom-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  min-height: 40px;
  flex-shrink: 0;
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-card);
  background: transparent;
  color: inherit;
  text-align: left;
  transition:
    background-color var(--duration-ds-fast) ease,
    border-color var(--duration-ds-fast) ease;
}

.option {
  cursor: pointer;
}

.option:disabled {
  cursor: default;
}

.option:hover:not(:disabled),
.option[data-selected],
.custom-row:hover,
.custom-row:focus-within,
.custom-row[data-active] {
  background: var(--interactive-bg-hover);
}

.option[data-selected],
.custom-row:focus-within,
.custom-row[data-active] {
  border-color: var(--border-l2);
}

.option:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.number {
  display: grid;
  place-items: center;
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  margin-top: var(--space-0-5);
  border-radius: var(--radius-sm);
  background: rgb(var(--bg-overlay));
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  font-weight: 500;
  line-height: 18px;
}

.checkbox {
  display: grid;
  place-items: center;
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  margin-top: var(--space-0-5);
}

.checkbox::before {
  content: '';
  grid-area: 1 / 1;
  width: 14px;
  height: 14px;
  border: 1px solid var(--border-l4);
  border-radius: var(--radius-xs);
  transition:
    background-color var(--duration-ds-fast) ease,
    border-color var(--duration-ds-fast) ease;
}

.checkbox > svg {
  grid-area: 1 / 1;
}

.checkbox[data-checked] {
  color: rgb(var(--label-inverted));
}

.checkbox[data-checked]::before {
  border-color: rgb(var(--label-primary));
  background: rgb(var(--label-primary));
}

.option-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-0-5) var(--space-1-5);
  min-width: 0;
  flex: 1;
}

.option-label {
  font-size: var(--fs-s);
  line-height: 24px;
  font-weight: 500;
}

.description {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-s);
  line-height: 24px;
  font-weight: 400;
}

/* Auto-growing text field: the hidden mirror sizes the grid cell, the
   textarea stretches to it. Both layers must share type and wrapping. */
.field {
  display: grid;
  flex: 1;
  min-width: 0;
}

.field > * {
  grid-area: 1 / 1;
  min-width: 0;
  padding: 0;
  font: inherit;
  font-size: var(--fs-s);
  line-height: 24px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.field-mirror {
  box-sizing: content-box;
  max-height: 144px;
  overflow: hidden;
  visibility: hidden;
}

.field-input {
  resize: none;
  overflow-y: auto;
  border: none;
  outline: none;
  background: transparent;
  color: rgb(var(--label-primary));
  caret-color: rgb(var(--accent-fill));
}

.field-input::placeholder {
  color: rgb(var(--label-caption));
}

.field-block {
  flex: none;
  min-height: 64px;
  margin: var(--space-2) var(--space-6) 0;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-cell);
  background: rgb(var(--bg-overlay));
}

.field-block > * {
  padding: var(--space-2) var(--space-3);
}

.field-block:focus-within {
  border-color: rgb(var(--accent-fill));
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-shrink: 0;
  margin-top: var(--space-3);
  padding: 0 var(--space-2-5) 0 calc(var(--space-4) + 2px);
}

.pager {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  flex-shrink: 0;
}

.progress {
  padding: 0 var(--space-1);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-s);
  line-height: 24px;
  font-weight: 500;
  white-space: nowrap;
  word-spacing: -2px;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.kbd {
  color: rgb(var(--label-tertiary));
  font-family: inherit;
  font-size: var(--fs-xxxs);
  line-height: 16px;
}

@media (max-width: 720px) {
  .header {
    padding: var(--space-2-5) var(--space-3) 0 calc(var(--space-4) + 2px);
  }

  .options {
    padding: var(--space-1) var(--space-2);
  }

  .option,
  .custom-row {
    padding: var(--space-2) var(--space-1-5);
  }

  .footer {
    align-items: flex-end;
    padding: 0 var(--space-2-5);
  }
}
</style>
