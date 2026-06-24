<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ControlInteraction, RuntimePlanRecord, RuntimePlanStep } from '../../types'
import { useAppContext } from '../../composables/useAppContext'
import { planExecutionSummary, type IndependentVerificationStatus } from '../../runtime/handlers/plans'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ interaction: ControlInteraction; plan?: RuntimePlanRecord | null }>()
const ctx = useAppContext()
const comment = ref('')

const waiting = computed(() => props.interaction.status === 'waiting')
const comments = computed(() => props.interaction.comments || [])
const runtimePlan = computed(() => props.plan || null)
const planSteps = computed(() => runtimePlan.value?.steps || [])
const executionSummary = computed(() => planExecutionSummary(runtimePlan.value))
const riskLabel = computed(() => {
  if (props.interaction.risk_level === 'high') return '高风险'
  if (props.interaction.risk_level === 'low') return '低风险'
  return '中风险'
})
const runtimeStatusLabel = computed(() => statusLabel(runtimePlan.value?.status || props.interaction.status))
const planDiscoveries = computed(() => {
  const discoveries = runtimePlan.value?.draft?.discoveries || []
  return discoveries.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
})
const recentDiscoveries = computed(() => planDiscoveries.value.slice(-3).reverse())
const showExecutionSummary = computed(() => {
  const summary = executionSummary.value
  return Boolean(
    summary.activeStep ||
    summary.failedVerificationSummary ||
    summary.blockedReason ||
    summary.openQuestionsCount ||
    summary.independentVerificationStatus !== 'none' ||
    planDiscoveries.value.length,
  )
})

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

function independentVerificationLabel(status: IndependentVerificationStatus) {
  const labels: Record<IndependentVerificationStatus, string> = {
    none: '无',
    required: '待独立复核',
    passed: '复核通过',
    failed: '复核失败',
    waived: '用户豁免',
    missing_command_evidence: '缺少命令证据',
  }
  return labels[status]
}

function independentVerificationTone(status: IndependentVerificationStatus) {
  if (status === 'passed' || status === 'waived') return 'ok'
  if (status === 'failed' || status === 'missing_command_evidence') return 'danger'
  if (status === 'required') return 'warn'
  return ''
}

function compactList(items?: string[], limit = 3) {
  const visible = (items || []).filter(Boolean).slice(0, limit)
  if (!visible.length) return ''
  const suffix = (items || []).length > limit ? ` +${(items || []).length - limit}` : ''
  return `${visible.join(', ')}${suffix}`
}

function discoveryString(item: Record<string, unknown>, key: string): string {
  const value = item[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function discoveryList(item: Record<string, unknown>, key: string): string[] {
  const value = item[key]
  if (!Array.isArray(value)) return []
  return value.map((entry) => String(entry || '').trim()).filter(Boolean)
}

function discoverySummary(item: Record<string, unknown>): string {
  return discoveryString(item, 'summary') || discoveryString(item, 'source') || '已记录探索证据'
}

function discoveryFiles(item: Record<string, unknown>): string {
  return compactList(discoveryList(item, 'files'), 2)
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

    <div v-if="runtimePlan" class="plan-runtime">
      <div class="plan-runtime-head">
        <span>Execution Trace</span>
        <em :class="['plan-runtime-status', runtimePlan.status]">{{ runtimeStatusLabel }}</em>
      </div>
      <div v-if="showExecutionSummary" class="plan-execution-summary">
        <div v-if="executionSummary.activeStep" class="plan-summary-item active">
          <span>Active Step</span>
          <strong>{{ executionSummary.activeStep.title }}</strong>
        </div>
        <div v-if="executionSummary.openQuestionsCount" class="plan-summary-item warn">
          <span>Open Questions</span>
          <strong>{{ executionSummary.openQuestionsCount }}</strong>
        </div>
        <div v-if="executionSummary.blockedReason" class="plan-summary-item danger">
          <span>Blocked</span>
          <strong>{{ executionSummary.blockedReason }}</strong>
        </div>
        <div v-if="executionSummary.failedVerificationSummary" class="plan-summary-item danger">
          <span>Failed Verification</span>
          <strong>{{ executionSummary.failedVerificationSummary }}</strong>
        </div>
        <div
          v-if="executionSummary.independentVerificationStatus !== 'none'"
          class="plan-summary-item"
          :class="independentVerificationTone(executionSummary.independentVerificationStatus)"
        >
          <span>Independent Review</span>
          <strong>{{ independentVerificationLabel(executionSummary.independentVerificationStatus) }}</strong>
          <p v-if="executionSummary.independentVerificationSummary">
            {{ executionSummary.independentVerificationSummary }}
          </p>
          <code
            v-for="command in executionSummary.independentVerificationCommands"
            :key="command"
          >{{ command }}</code>
          <small v-if="executionSummary.riskSignals.length">
            Risk: {{ compactList(executionSummary.riskSignals, 4) }}
          </small>
        </div>
        <div v-if="planDiscoveries.length" class="plan-summary-item ok">
          <span>Exploration Evidence</span>
          <strong>{{ planDiscoveries.length }}</strong>
          <p v-for="item in recentDiscoveries" :key="discoveryString(item, 'id') || discoverySummary(item)">
            {{ discoverySummary(item) }}
          </p>
          <small
            v-for="item in recentDiscoveries"
            v-show="discoveryFiles(item)"
            :key="`${discoveryString(item, 'id') || discoverySummary(item)}-files`"
          >
            Files: {{ discoveryFiles(item) }}
          </small>
        </div>
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

    <div class="plan-markdown">
      <MarkdownBlock :content="props.interaction.plan_markdown || ''" />
    </div>

    <div v-if="props.interaction.assumptions?.length" class="plan-assumptions">
      <span>Assumptions</span>
      <ul>
        <li v-for="item in props.interaction.assumptions" :key="item">{{ item }}</li>
      </ul>
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
