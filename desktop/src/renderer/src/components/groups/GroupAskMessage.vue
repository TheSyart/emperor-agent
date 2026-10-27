<script setup lang="ts">
/**
 * GroupAskMessage — what a member asks of the user while it speaks, shown
 * in the room as that member's message (GRP-08, D29), not as the pop-up
 * card a plain conversation has:
 * - a question (ask_user_question): the question, its options as quick
 *   replies — one question with one choice answers on a tap — and a line
 *   to answer in one's own words;
 * - an approval (a permission, or Claude Code / Codex's first use): what it
 *   wants to do and the decisions as buttons;
 * - a plan or a computer-use grant: a pointer to the member's own work,
 *   where its full card is.
 * Once answered it leaves the room; the group log keeps a line of what the
 * user answered (GRP-12).
 *
 * Props: ask; name; avatar.
 * Emits: answer({ answers }), cancel, process.
 */
import { computed, reactive, ref } from 'vue'
import type { ControlQuestion } from '../../types'
import type { ContactAvatarProps } from '../contacts/contactAvatar'
import {
  approvalActions,
  approvalAnswer,
  approvalPresentation,
  isPermissionInteraction,
  type ApprovalAction,
} from '../conversation/takeover/approvalModel'
import {
  askOptionActive,
  ensureAskDraft,
  toggleAskOption,
  toPlainAskAnswers,
  type AskAnswerDrafts,
} from '../conversation/takeover/questionModel'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import Chip from '../ui/Chip.vue'
import LinkButton from '../ui/LinkButton.vue'
import TextField from '../ui/TextField.vue'
import type { GroupAsk } from './groupModel'

const props = defineProps<{
  ask: GroupAsk
  name: string
  avatar: ContactAvatarProps | { kind: 'initials'; label: string }
}>()
const emit = defineEmits<{
  answer: [payload: { answers: Record<string, unknown> }]
  cancel: []
  process: []
}>()

const interaction = computed(() => props.ask.interaction)
const kind = computed<'approval' | 'question' | 'elsewhere'>(() => {
  const value = interaction.value
  if (isPermissionInteraction(value)) return 'approval'
  if (
    value.kind === 'plan' ||
    value.meta?.interaction_type === 'computer_use_grant'
  )
    return 'elsewhere'
  return 'question'
})

// ── approval ────────────────────────────────────────────────────────────
const presentation = computed(() => approvalPresentation(interaction.value))
const actions = computed(() => approvalActions(interaction.value))
const summary = computed(
  () =>
    presentation.value.operations
      .map((operation) => operation.summary)
      .filter(Boolean)
      .join('\n') || '',
)

function decide(action: ApprovalAction): void {
  emit('answer', { answers: approvalAnswer(interaction.value, action) })
}

// ── question ────────────────────────────────────────────────────────────
const questions = computed<ControlQuestion[]>(
  () => interaction.value.questions ?? [],
)
const drafts = reactive<AskAnswerDrafts>({})
const freeform = ref<Record<string, string>>({})
/** One question with one choice: a tap on an option answers it. */
const quick = computed(
  () => questions.value.length === 1 && !questions.value[0]!.multi_select,
)

function draft(question: ControlQuestion) {
  return ensureAskDraft(drafts, question.id)
}

function sendAnswers(): void {
  for (const question of questions.value)
    draft(question).freeform = freeform.value[question.id] ?? ''
  const answers = toPlainAskAnswers(questions.value, drafts)
  if (Object.keys(answers).length < questions.value.length) return
  emit('answer', { answers })
}

function tap(
  question: ControlQuestion,
  option: ControlQuestion['options'][number],
): void {
  const current = draft(question)
  toggleAskOption(current, question, option)
  if (quick.value && current.choice) {
    freeform.value = {}
    sendAnswers()
  }
}

const ready = computed(() =>
  questions.value.every((question) => {
    const current = drafts[question.id]
    return Boolean(
      current?.choice?.trim() || freeform.value[question.id]?.trim(),
    )
  }),
)

function setFreeform(id: string, value: string): void {
  freeform.value = { ...freeform.value, [id]: value }
}
</script>

<template>
  <div
    class="ask"
    :data-group-ask="kind === 'question' ? '' : undefined"
    :data-group-approval="kind === 'approval' ? '' : undefined"
  >
    <Avatar v-bind="avatar" :size="28" />
    <div class="main">
      <div class="who">
        <b>{{ name }}</b>
        <span class="tag" :data-kind="kind">{{
          kind === 'approval'
            ? '需要你批准'
            : kind === 'elsewhere'
              ? '等你处理'
              : '问你'
        }}</span>
      </div>

      <template v-if="kind === 'approval'">
        <p class="text">{{ presentation.headline }}</p>
        <pre v-if="summary" class="summary">{{ summary }}</pre>
        <div class="choices">
          <Button
            v-for="action in actions"
            :key="action.key"
            size="sm"
            :variant="action.variant"
            :title="action.description || undefined"
            @click="decide(action)"
            >{{ action.label }}</Button
          >
        </div>
      </template>

      <template v-else-if="kind === 'elsewhere'">
        <p class="text">
          {{
            interaction.kind === 'plan'
              ? `${name} 写好了计划，等你审阅。`
              : `${name} 想操作这台电脑，等你授权。`
          }}
        </p>
        <div class="choices">
          <Button size="sm" variant="secondary" @click="emit('process')"
            >去处理 ›</Button
          >
        </div>
      </template>

      <template v-else>
        <div v-for="question in questions" :key="question.id" class="question">
          <span v-if="question.header && questions.length > 1" class="header">{{
            question.header
          }}</span>
          <p class="text">{{ question.question }}</p>
          <div class="replies" role="group" :aria-label="question.question">
            <Chip
              v-for="option in question.options"
              :key="option.id || option.label"
              :active="askOptionActive(draft(question), question, option)"
              :aria-pressed="askOptionActive(draft(question), question, option)"
              :title="option.description || undefined"
              class="reply"
              data-reply
              @click="tap(question, option)"
              >{{ option.label }}</Chip
            >
          </div>
          <div class="own">
            <TextField
              size="sm"
              :model-value="freeform[question.id] ?? ''"
              placeholder="或者自己写…"
              :aria-label="`回答：${question.question}`"
              @update:model-value="setFreeform(question.id, $event)"
              @keydown.enter.prevent="ready && sendAnswers()"
            />
          </div>
        </div>
        <div class="choices">
          <Button
            size="sm"
            variant="secondary"
            data-reply-send
            :disabled="!ready"
            @click="sendAnswers"
            >回答</Button
          >
          <LinkButton class="skip" @click="emit('cancel')">不回答</LinkButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ask {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: var(--space-2-5);
  max-width: 780px;
}

.main {
  display: grid;
  gap: var(--space-1-5);
  min-width: 0;
}

.who {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.who b {
  font-weight: var(--weight-semibold);
}

.tag {
  padding: 0 var(--space-1-5);
  border-radius: var(--r-xs);
  background: rgb(var(--attention-soft));
  color: rgb(var(--attention));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxs);
}

.question {
  display: grid;
  gap: var(--space-1-5);
}

.header {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.text {
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.summary {
  margin: 0;
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--r-sm);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-2));
  font-family: var(--font-mono);
  font-size: var(--fs-code);
  line-height: var(--lh-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.replies {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.reply {
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
  color: rgb(var(--text-1));
}

.reply[data-active] {
  background: rgb(var(--accent-soft));
  box-shadow: inset 0 0 0 1px rgb(var(--accent));
}

.own {
  max-width: 360px;
}

.choices {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
}

.skip {
  margin-left: var(--space-1);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
</style>
