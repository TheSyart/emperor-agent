<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ControlInteraction, RuntimePlanRecord, RuntimePlanStep } from '../../types'
import { useAppContext } from '../../composables/useAppContext'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ interaction: ControlInteraction; plan?: RuntimePlanRecord | null }>()
const ctx = useAppContext()
const comment = ref('')

const waiting = computed(() => props.interaction.status === 'waiting')
const comments = computed(() => props.interaction.comments || [])
const runtimePlan = computed(() => props.plan || null)
const planSteps = computed(() => runtimePlan.value?.steps || [])
const riskLabel = computed(() => {
  if (props.interaction.risk_level === 'high') return '高风险'
  if (props.interaction.risk_level === 'low') return '低风险'
  return '中风险'
})
const runtimeStatusLabel = computed(() => statusLabel(runtimePlan.value?.status || props.interaction.status))

function approve() {
  ctx.approvePlan(props.interaction.id)
}

function sendComment() {
  const text = comment.value.trim()
  if (!text) return
  if (ctx.sendPlanComment(props.interaction.id, text)) comment.value = ''
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}

function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    waiting: '待处理',
    waiting_approval: '待批准',
    approved: '已批准',
    executing: '执行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    pending: '待执行',
    active: '执行中',
    done: '已完成',
    blocked: '受阻',
    skipped: '已跳过',
  }
  const key = String(status || '').trim()
  return labels[key] || key || '未知'
}

function latestEvidence(step: RuntimePlanStep): Record<string, unknown> | null {
  const items = step.evidence || []
  const item = items[items.length - 1]
  return item && typeof item === 'object' ? item : null
}

function evidenceValue(evidence: Record<string, unknown> | null, key: string): string {
  const value = evidence?.[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function evidenceLabel(step: RuntimePlanStep) {
  const passed = latestEvidence(step)?.passed
  if (passed === true) return '验证通过'
  if (passed === false) return '验证失败'
  return '执行证据'
}

function evidenceFailed(step: RuntimePlanStep) {
  return latestEvidence(step)?.passed === false
}

function evidenceSummary(step: RuntimePlanStep) {
  const evidence = latestEvidence(step)
  return evidenceValue(evidence, 'summary') ||
    evidenceValue(evidence, 'error') ||
    evidenceValue(evidence, 'stdout_tail') ||
    evidenceValue(evidence, 'stderr_tail') ||
    '已记录执行证据'
}

function evidenceCommand(step: RuntimePlanStep) {
  return evidenceValue(latestEvidence(step), 'command')
}

function evidenceFailureDetail(step: RuntimePlanStep) {
  if (!evidenceFailed(step)) return ''
  const evidence = latestEvidence(step)
  return evidenceValue(evidence, 'stderr_tail') || evidenceValue(evidence, 'stdout_tail')
}

function compactList(items?: string[], limit = 3) {
  const visible = (items || []).filter(Boolean).slice(0, limit)
  if (!visible.length) return ''
  const suffix = (items || []).length > limit ? ` +${(items || []).length - limit}` : ''
  return `${visible.join(', ')}${suffix}`
}
</script>

<template>
  <section class="control-card plan-card" :class="props.interaction.status">
    <header class="control-card-head">
      <span>Plan Preview</span>
      <strong>{{ props.interaction.title || '待批准计划' }}</strong>
      <em>{{ riskLabel }}</em>
    </header>
    <p v-if="props.interaction.summary" class="control-context">{{ props.interaction.summary }}</p>

    <div class="plan-markdown">
      <MarkdownBlock :content="props.interaction.plan_markdown || ''" />
    </div>

    <div v-if="props.interaction.assumptions?.length" class="plan-assumptions">
      <span>Assumptions</span>
      <ul>
        <li v-for="item in props.interaction.assumptions" :key="item">{{ item }}</li>
      </ul>
    </div>

    <div v-if="runtimePlan" class="plan-runtime">
      <div class="plan-runtime-head">
        <span>Execution Trace</span>
        <em :class="['plan-runtime-status', runtimePlan.status]">{{ runtimeStatusLabel }}</em>
      </div>
      <ol v-if="planSteps.length" class="plan-step-list">
        <li
          v-for="(step, index) in planSteps"
          :key="step.id"
          class="plan-step-item"
          :class="step.status"
        >
          <div class="plan-step-head">
            <span class="plan-step-index">{{ index + 1 }}</span>
            <div class="plan-step-copy">
              <strong>{{ step.title }}</strong>
              <p v-if="step.description">{{ step.description }}</p>
            </div>
            <em class="plan-step-status">{{ statusLabel(step.status) }}</em>
          </div>
          <div v-if="step.files?.length || step.commands?.length" class="plan-step-meta">
            <span v-if="step.files?.length">Files: {{ compactList(step.files) }}</span>
            <span v-if="step.commands?.length">Command: {{ compactList(step.commands, 2) }}</span>
          </div>
          <div
            v-if="latestEvidence(step)"
            class="plan-step-evidence"
            :class="{ failed: evidenceFailed(step) }"
          >
            <span>{{ evidenceLabel(step) }}</span>
            <p>{{ evidenceSummary(step) }}</p>
            <code v-if="evidenceCommand(step)">{{ evidenceCommand(step) }}</code>
            <pre v-if="evidenceFailureDetail(step)">{{ evidenceFailureDetail(step) }}</pre>
          </div>
        </li>
      </ol>
      <p v-else class="plan-runtime-empty">批准后会在这里记录执行步骤与验证结果。</p>
    </div>

    <div v-if="comments.length" class="plan-comments">
      <span>评论历史</span>
      <p v-for="item in comments" :key="`${item.timestamp}-${item.content}`">{{ item.content }}</p>
    </div>

    <footer v-if="waiting" class="plan-action-zone">
      <textarea v-model="comment" rows="3" placeholder="写下修改意见，Agent 会据此重出计划" />
      <div class="control-actions">
        <button class="control-secondary" type="button" @click="cancel">取消</button>
        <button class="control-secondary" type="button" :disabled="!comment.trim()" @click="sendComment">提交评论</button>
        <button class="control-primary" type="button" @click="approve">批准执行</button>
      </div>
    </footer>
    <footer v-else class="control-footnote">状态：{{ props.interaction.status }}</footer>
  </section>
</template>
