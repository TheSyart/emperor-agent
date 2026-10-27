<script setup lang="ts">
/**
 * TrialBench — 试用台 (GRP-04): runs the editor's unsaved draft once on a
 * sample task (`contacts.trial`, a hidden session that is cleared after 24
 * hours) and shows the answer and what it cost. The run starts only when
 * the user presses 运行 (a real model call). 停止 — or leaving the editor
 * while it runs — stops it (`contacts.stopTrial`).
 *
 * Props: draft (what to run); defaultTask (the role's sample task);
 * disabled? with disabledReason?.
 * Emits: ran(result) after every run; update:task(task) as the user edits
 * the sample task (the editor keeps it as the role's trialTask).
 */
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import type { ContactDraftInput, ContactTrialResult } from '@emperor/core/api'
import { core } from '../../api/http'
import Button from '../ui/Button.vue'
import Field from '../ui/Field.vue'
import Spinner from '../ui/Spinner.vue'
import TextArea from '../ui/TextArea.vue'
import { charHint, failureText, LIMITS } from './contactEditorModel'

const props = withDefaults(
  defineProps<{
    draft: ContactDraftInput
    defaultTask?: string
    disabled?: boolean
    disabledReason?: string
  }>(),
  { defaultTask: '', disabled: false, disabledReason: '' },
)
const emit = defineEmits<{
  ran: [result: ContactTrialResult]
  'update:task': [task: string]
}>()

const task = ref(props.defaultTask)
const running = ref(false)
const trialId = ref<string | null>(null)
const result = ref<ContactTrialResult | null>(null)
const error = ref('')

watch(
  () => props.defaultTask,
  (value) => {
    if (value !== task.value) task.value = value
  },
)
watch(task, (value) => {
  if (value !== props.defaultTask) emit('update:task', value)
})

const hint = computed(() => charHint(task.value, LIMITS.trialTask))
const canRun = computed(
  () => !props.disabled && !running.value && task.value.trim() !== '',
)

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function newTrialId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `tr-${Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('')}`
}

async function run() {
  if (!canRun.value) return
  const id = newTrialId()
  trialId.value = id
  running.value = true
  result.value = null
  error.value = ''
  try {
    const outcome = await core('contacts.trial', {
      // A plain copy: IPC cannot send Vue's reactive proxies.
      draft: JSON.parse(JSON.stringify(props.draft)) as ContactDraftInput,
      task: task.value.trim(),
      trialId: id,
    })
    result.value = outcome
    emit('ran', outcome)
  } catch (failure) {
    error.value = failureText(failure)
  } finally {
    if (trialId.value === id) {
      running.value = false
      trialId.value = null
    }
  }
}

function stop() {
  const id = trialId.value
  if (!id) return
  void core('contacts.stopTrial', { trialId: id }).catch(() => undefined)
}

// Closing the editor (or leaving it kept alive) stops a running trial.
onDeactivated(stop)
onBeforeUnmount(stop)

function money(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  if (usd >= 1) return `$${usd.toFixed(2)}`
  return `$${Number(usd.toPrecision(2))}`
}

const facts = computed(() => {
  const outcome = result.value
  if (!outcome) return ''
  const cost =
    outcome.costUsd === null
      ? '花费未知（这个模型没有价格）'
      : `花费 ${money(outcome.costUsd)}`
  const tokens = `输入 ${outcome.usage.inputTokens.toLocaleString('en-US')} · 输出 ${outcome.usage.outputTokens.toLocaleString('en-US')} tokens`
  const seconds = `${Math.max(1, Math.round(outcome.durationMs / 1000))} 秒`
  return [cost, tokens, seconds].join(' · ')
})

const statusLabel = computed(() => {
  switch (result.value?.status) {
    case 'completed':
      return '试用结果'
    case 'failed':
      return '没能跑完'
    case 'stopped':
      return '已停止'
    default:
      return ''
  }
})
</script>

<template>
  <section class="bench" data-trial-bench aria-label="试用台">
    <header class="head">
      <h3 class="title">试用台</h3>
      <Button v-if="running" size="sm" variant="secondary" @click="stop"
        >停止</Button
      >
      <Button
        v-else
        size="sm"
        variant="secondary"
        :disabled="!canRun"
        @click="run"
        >{{ result ? '再跑一次' : '运行' }}</Button
      >
    </header>
    <Field
      label="样例任务"
      :hint="hint.text"
      :error="hint.over ? hint.text : undefined"
    >
      <TextArea
        v-model="task"
        :min-rows="2"
        :max-rows="6"
        :disabled="running || disabled"
        placeholder="写一条能直接交给它做的任务"
      />
    </Field>
    <p v-if="disabled && disabledReason" class="note">{{ disabledReason }}</p>
    <p v-else class="note">
      在隐藏会话里用还没保存的设置跑一次，24
      小时后清理；需要批准的操作会被拒绝。
    </p>
    <p v-if="running" class="running" role="status">
      <Spinner size="sm" />正在试用…
    </p>
    <p v-if="error" class="failed" role="alert">{{ error }}</p>
    <div
      v-if="result"
      class="result"
      :data-trial-status="result.status"
      role="status"
    >
      <span class="status">{{ statusLabel }}</span>
      <p v-if="result.text" class="answer">{{ result.text }}</p>
      <p v-else-if="result.status === 'completed'" class="answer empty">
        （没有回答）
      </p>
      <span class="facts">{{ facts }}</span>
    </div>
  </section>
</template>

<style scoped>
.bench {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.title {
  margin: 0;
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
}

.note,
.running {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.running {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  color: rgb(var(--text-2));
}

.failed {
  margin: 0;
  color: rgb(var(--error));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.result {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
}

.status {
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: var(--weight-medium);
}

.result[data-trial-status='failed'] .status {
  color: rgb(var(--error));
}

.answer {
  margin: 0;
  max-height: 280px;
  overflow-y: auto;
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.answer.empty {
  color: rgb(var(--text-3));
}

.facts {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}
</style>
