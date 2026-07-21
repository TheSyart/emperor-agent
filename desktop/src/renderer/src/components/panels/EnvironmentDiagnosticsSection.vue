<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Download,
  FileText,
  LoaderCircle,
  RefreshCcw,
  ShieldAlert,
  Square,
  TerminalSquare,
  TriangleAlert,
  X,
} from 'lucide-vue-next'
import { core } from '../../api/http'
import { onCoreEvent } from '../../api/backend'
import {
  environmentErrorPresentation,
  environmentJobStatusLabel,
  environmentJobTone,
  environmentPlanReview,
  environmentToolSections,
  environmentToolStatusLabel,
  environmentToolTone,
  formatEnvironmentBytes,
  installableEnvironmentToolIds,
  type EnvironmentInstallPlan,
  type EnvironmentJob,
  type EnvironmentLogPage,
  type EnvironmentPlanStepReview,
  type EnvironmentStatusPayload,
  type EnvironmentTool,
} from './environmentPanelModel'

const statusPayload = ref<EnvironmentStatusPayload | null>(null)
const loading = ref(false)
const planning = ref(false)
const installing = ref(false)
const cancelling = ref(false)
const error = ref('')
const errorCode = ref('')
const plan = ref<EnvironmentInstallPlan | null>(null)
const acceptedLicenses = ref<string[]>([])
const separateConfirmed = ref(false)
const latestJob = ref<EnvironmentJob | null>(null)
const selectedJobId = ref('')
const logPage = ref<EnvironmentLogPage | null>(null)
const logsLoading = ref(false)
const progress = ref<{
  jobId: string
  status: string
  completed: number
  total: number
  toolId: string
  stepId: string
  errorCode: string
} | null>(null)
let unsubscribe = () => {}

const sections = computed(() => environmentToolSections(statusPayload.value))
const installableIds = computed(() =>
  installableEnvironmentToolIds(statusPayload.value),
)
const reviewSteps = computed<EnvironmentPlanStepReview[]>(() =>
  plan.value && statusPayload.value
    ? environmentPlanReview(plan.value, statusPayload.value)
    : [],
)
const requiredLicenses = computed(() => {
  const required = new Set(plan.value?.requiredLicenseIds || [])
  return (statusPayload.value?.catalog.licenses || []).filter((license) =>
    required.has(license.id),
  )
})
const needsSeparateConfirmation = computed(() =>
  reviewSteps.value.some((step) => step.requiresSeparateConfirmation),
)
const canInstallPlan = computed(
  () =>
    Boolean(plan.value) &&
    requiredLicenses.value.every((license) =>
      acceptedLicenses.value.includes(license.id),
    ) &&
    (!needsSeparateConfirmation.value || separateConfirmed.value) &&
    !installing.value,
)
const totalDownloadBytes = computed(() =>
  reviewSteps.value.reduce((sum, step) => sum + step.estimatedBytes, 0),
)
const currentJob = computed(() => {
  if (latestJob.value) return latestJob.value
  const jobs = statusPayload.value?.recentJobs || []
  return (
    jobs.find((job) => job.jobId === selectedJobId.value) ||
    statusPayload.value?.activeJob ||
    jobs[0] ||
    null
  )
})
const visibleProgress = computed(() => {
  if (progress.value) return progress.value
  const job = statusPayload.value?.activeJob
  if (!job) return null
  return {
    jobId: job.jobId,
    status: job.status,
    completed: job.steps.filter((step) => step.status === 'completed').length,
    total: job.steps.length,
    toolId:
      job.steps.find((step) => step.stepId === job.currentStepId)?.toolId || '',
    stepId: job.currentStepId || '',
    errorCode: job.error?.code || '',
  }
})
const progressPercent = computed(() => {
  const value = visibleProgress.value
  if (!value?.total) return 0
  return Math.round((value.completed / value.total) * 100)
})
const errorPresentation = computed(() =>
  environmentErrorPresentation(errorCode.value),
)

onMounted(() => {
  unsubscribe = onCoreEvent(handleRuntimeEvent)
  void refresh(true)
})

onUnmounted(() => unsubscribe())

defineExpose({ refresh })

async function refresh(forceRefresh = false) {
  if (loading.value) return
  loading.value = true
  clearError()
  try {
    const payload = await core('environment.getStatus', { forceRefresh })
    statusPayload.value = payload
    const preferred =
      payload.activeJob?.jobId ||
      selectedJobId.value ||
      payload.recentJobs[0]?.jobId
    if (preferred) {
      selectedJobId.value = preferred
      await loadLogs(true)
    }
  } catch (reason) {
    captureError(reason)
  } finally {
    loading.value = false
  }
}

async function createPlan(toolIds: EnvironmentTool['id'][]) {
  if (!toolIds.length || planning.value) return
  planning.value = true
  clearError()
  try {
    plan.value = await core('environment.createInstallPlan', { toolIds })
    acceptedLicenses.value = []
    separateConfirmed.value = false
  } catch (reason) {
    captureError(reason)
  } finally {
    planning.value = false
  }
}

function closePlan() {
  if (installing.value) return
  plan.value = null
  acceptedLicenses.value = []
  separateConfirmed.value = false
}

async function confirmInstall() {
  if (!plan.value || !canInstallPlan.value) return
  const currentPlan = plan.value
  installing.value = true
  clearError()
  plan.value = null
  try {
    const job = await core('environment.install', {
      planId: currentPlan.planId,
      acceptedLicenseIds: [...acceptedLicenses.value],
      confirmedStepIds: currentPlan.steps
        .filter(
          (step) =>
            !step.requiresSeparateConfirmation || separateConfirmed.value,
        )
        .map((step) => step.stepId),
    })
    latestJob.value = job
    selectedJobId.value = job.jobId
    await refresh(true)
  } catch (reason) {
    captureError(reason)
    if (errorCode.value === 'confirmation_required') plan.value = currentPlan
    if (errorCode.value === 'plan_stale') await refresh(true)
  } finally {
    installing.value = false
  }
}

async function cancelInstall() {
  const jobId = visibleProgress.value?.jobId
  if (!jobId || cancelling.value) return
  cancelling.value = true
  clearError()
  try {
    const result = await core('environment.cancelInstall', { jobId })
    if (result.job) latestJob.value = result.job
    await loadLogs(true)
  } catch (reason) {
    captureError(reason)
  } finally {
    cancelling.value = false
  }
}

async function selectJob(jobId: string) {
  selectedJobId.value = jobId
  latestJob.value =
    statusPayload.value?.recentJobs.find((job) => job.jobId === jobId) || null
  await loadLogs(true)
}

async function loadLogs(reset = false) {
  const jobId = selectedJobId.value || visibleProgress.value?.jobId
  if (!jobId || logsLoading.value) return
  logsLoading.value = true
  try {
    const page = await core('environment.getInstallLog', {
      jobId,
      cursor: reset ? 0 : logPage.value?.nextCursor || 0,
      limit: 50,
    })
    logPage.value = reset
      ? page
      : {
          ...page,
          records: [...(logPage.value?.records || []), ...page.records],
          badLines: [
            ...(logPage.value?.badLines || []),
            ...page.badLines,
          ].slice(0, 20),
        }
  } catch (reason) {
    captureError(reason)
  } finally {
    logsLoading.value = false
  }
}

function handleRuntimeEvent(raw: unknown) {
  if (!raw || typeof raw !== 'object') return
  const event = raw as Record<string, unknown>
  const eventName = String(event.event || '')
  if (!eventName.startsWith('environment_')) return
  const jobId = String(event.job_id || '')
  if (jobId && eventName !== 'environment_changed') {
    progress.value = {
      jobId,
      status: String(event.status || ''),
      completed: Number(event.completed_steps || 0),
      total: Number(event.total_steps || 0),
      toolId: String(event.tool_id || ''),
      stepId: String(event.step_id || ''),
      errorCode: String(event.error_code || ''),
    }
    selectedJobId.value = jobId
    void loadLogs(true)
  }
  if (
    eventName === 'environment_install_completed' ||
    eventName === 'environment_install_failed' ||
    eventName === 'environment_changed'
  ) {
    if (event.error_code) errorCode.value = String(event.error_code)
    void refresh(true)
  }
}

function captureError(reason: unknown) {
  const value = reason as { message?: unknown; code?: unknown }
  error.value =
    typeof value?.message === 'string' ? value.message : String(reason)
  errorCode.value = typeof value?.code === 'string' ? value.code : ''
}

function clearError() {
  error.value = ''
  errorCode.value = ''
}

function toolIcon(status: EnvironmentTool['status']) {
  if (status === 'ready') return CheckCircle2
  if (status === 'installing' || status === 'awaiting_user') return LoaderCircle
  if (status === 'blocked' || status === 'failed') return Ban
  if (status === 'missing' || status === 'version_mismatch')
    return TriangleAlert
  return CircleDashed
}

function canInstallTool(tool: EnvironmentTool): boolean {
  return Boolean(
    tool.required &&
    tool.installStrategy &&
    (tool.status === 'missing' || tool.status === 'version_mismatch'),
  )
}

function platformLabel() {
  const status = statusPayload.value?.status
  if (!status) return '检测中'
  const platform =
    status.platform === 'darwin'
      ? 'macOS'
      : status.platform === 'win32'
        ? 'Windows'
        : 'Ubuntu'
  return `${platform} · ${status.arch}`
}

function licenseChecked(id: string): boolean {
  return acceptedLicenses.value.includes(id)
}

function setLicense(id: string, checked: boolean) {
  acceptedLicenses.value = checked
    ? [...new Set([...acceptedLicenses.value, id])]
    : acceptedLicenses.value.filter((value) => value !== id)
}

function logDetails(details: Record<string, unknown>): string {
  return Object.keys(details).length ? JSON.stringify(details) : ''
}
</script>

<template>
  <section
    class="diagnostics-group environment-diagnostics"
    data-testid="environment-section"
  >
    <div class="diagnostics-group-head environment-head">
      <div>
        <strong>开发环境</strong>
        <span>{{ platformLabel() }}</span>
      </div>
      <div class="environment-actions">
        <button
          class="tool-button asset-button"
          :disabled="loading || planning || !installableIds.length"
          data-testid="install-required"
          @click="createPlan(installableIds)"
        >
          <Download :size="15" />
          <span>{{ planning ? '生成计划中' : '安装所需环境' }}</span>
        </button>
        <button
          class="icon-button"
          :disabled="loading"
          title="重新检测环境"
          aria-label="重新检测环境"
          @click="refresh(true)"
        >
          <RefreshCcw :size="15" :class="{ spinning: loading }" />
        </button>
      </div>
    </div>

    <div v-if="error" class="environment-error" role="alert">
      <AlertCircle :size="18" />
      <div>
        <strong>{{ errorPresentation.title }}</strong>
        <span>{{ error }}</span>
      </div>
      <button class="tool-button" @click="refresh(true)">
        {{ errorPresentation.action }}
      </button>
    </div>

    <div
      v-if="visibleProgress"
      class="environment-progress"
      data-testid="environment-progress"
    >
      <div class="environment-progress-head">
        <div>
          <LoaderCircle
            v-if="['running', 'cancelling'].includes(visibleProgress.status)"
            :size="16"
            class="spinning"
          />
          <TerminalSquare v-else :size="16" />
          <strong>{{
            environmentJobStatusLabel(visibleProgress.status)
          }}</strong>
          <span v-if="visibleProgress.toolId">{{
            visibleProgress.toolId
          }}</span>
        </div>
        <div>
          <code
            >{{ visibleProgress.completed }} / {{ visibleProgress.total }}</code
          >
          <button
            v-if="['running', 'awaiting_user'].includes(visibleProgress.status)"
            class="tool-button danger"
            :disabled="cancelling"
            @click="cancelInstall"
          >
            <Square :size="13" />
            {{ cancelling ? '取消中' : '取消' }}
          </button>
        </div>
      </div>
      <div class="environment-progress-track" aria-hidden="true">
        <span :style="{ width: `${progressPercent}%` }" />
      </div>
    </div>

    <div v-if="loading && !statusPayload" class="environment-empty">
      <LoaderCircle :size="18" class="spinning" />
      <span>正在检测开发环境</span>
    </div>

    <div v-else class="environment-sections">
      <section
        v-for="section in sections"
        :key="section.id"
        class="environment-tool-group"
      >
        <div class="environment-tool-group-head">
          <strong>{{ section.title }}</strong>
          <span>{{ section.tools.length }} 项</span>
        </div>
        <div class="environment-tool-list">
          <div
            v-for="tool in section.tools"
            :key="tool.id"
            class="settings-row environment-tool-row"
            :class="`tone-${environmentToolTone(tool.status)}`"
            :data-testid="`environment-tool-${tool.id}`"
          >
            <component
              :is="toolIcon(tool.status)"
              :size="18"
              :class="{ spinning: tool.status === 'installing' }"
            />
            <div>
              <strong>{{ tool.id }}</strong>
              <span>{{ tool.reason }}</span>
              <small v-if="tool.versionSummary || tool.requiredVersion">
                {{ tool.versionSummary || '未检测到版本' }}
                <template v-if="tool.requiredVersion">
                  · 要求 {{ tool.requiredVersion }}</template
                >
              </small>
            </div>
            <div class="environment-tool-tail">
              <code>{{ environmentToolStatusLabel(tool.status) }}</code>
              <button
                v-if="canInstallTool(tool)"
                class="tool-button"
                :disabled="planning || installing"
                :aria-label="`安装 ${tool.id}`"
                @click="createPlan([tool.id])"
              >
                <Download :size="14" />
                安装
              </button>
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="statusPayload?.status.skills.length"
        class="environment-tool-group"
      >
        <div class="environment-tool-group-head">
          <strong>Skill 状态</strong>
          <span>{{ statusPayload.status.skills.length }} 项</span>
        </div>
        <div class="environment-skill-list">
          <div
            v-for="skill in statusPayload.status.skills"
            :key="skill.skillName"
            class="environment-skill-row"
          >
            <CheckCircle2 v-if="skill.status === 'ready'" :size="16" />
            <TriangleAlert v-else :size="16" />
            <div>
              <strong>{{ skill.skillName }}</strong>
              <span>{{
                skill.missing.join(' · ') ||
                skill.unsupported.join(' · ') ||
                '依赖已满足'
              }}</span>
            </div>
            <code>{{ skill.status }}</code>
          </div>
        </div>
      </section>
    </div>

    <section
      v-if="statusPayload?.recentJobs.length"
      class="environment-history"
    >
      <div class="environment-tool-group-head">
        <strong>安装记录</strong>
        <span>最近 {{ statusPayload.recentJobs.length }} 次</span>
      </div>
      <div class="environment-job-tabs" role="list">
        <button
          v-for="job in statusPayload.recentJobs"
          :key="job.jobId"
          :class="{ active: selectedJobId === job.jobId }"
          :data-tone="environmentJobTone(job.status)"
          @click="selectJob(job.jobId)"
        >
          <span>{{ environmentJobStatusLabel(job.status) }}</span>
          <code>{{ job.jobId }}</code>
        </button>
      </div>

      <div v-if="currentJob" class="environment-job-detail">
        <div
          v-for="step in currentJob.steps"
          :key="step.stepId"
          class="environment-job-step"
        >
          <span>{{ step.toolId }}</span>
          <code>{{ environmentJobStatusLabel(step.status) }}</code>
        </div>
        <div v-if="currentJob.error" class="environment-job-error">
          <AlertCircle :size="15" />
          <span>{{
            environmentErrorPresentation(currentJob.error.code).title
          }}</span>
          <button class="tool-button" @click="refresh(true)">
            {{ environmentErrorPresentation(currentJob.error.code).action }}
          </button>
        </div>
      </div>

      <details
        class="environment-logs"
        :open="Boolean(logPage?.records.length)"
      >
        <summary>
          <FileText :size="15" />
          <span>脱敏安装日志</span>
          <code>{{ logPage?.total || 0 }}</code>
          <ChevronDown :size="14" />
        </summary>
        <div class="environment-log-list">
          <div
            v-for="(record, index) in logPage?.records || []"
            :key="`${record.timestamp}-${index}`"
          >
            <span>{{ record.level }}</span>
            <strong>{{ record.message }}</strong>
            <code v-if="logDetails(record.details)">{{
              logDetails(record.details)
            }}</code>
          </div>
          <p v-if="!logPage?.records.length">暂无日志。</p>
        </div>
        <button
          v-if="logPage?.nextCursor !== null"
          class="tool-button environment-more"
          :disabled="logsLoading"
          @click="loadLogs(false)"
        >
          {{ logsLoading ? '加载中' : '加载更多' }}
        </button>
      </details>
    </section>

    <div
      v-if="plan"
      class="modal-backdrop environment-modal-backdrop"
      @click.self="closePlan"
    >
      <section
        class="environment-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="environment-confirm-title"
      >
        <header>
          <div>
            <h2 id="environment-confirm-title">确认环境安装</h2>
            <p>
              {{ reviewSteps.length }} 个步骤 ·
              {{ formatEnvironmentBytes(totalDownloadBytes) }}
            </p>
          </div>
          <button
            class="icon-button"
            title="关闭"
            aria-label="关闭"
            @click="closePlan"
          >
            <X :size="16" />
          </button>
        </header>

        <div v-if="plan.warnings.length" class="environment-plan-warnings">
          <TriangleAlert :size="17" />
          <div>
            <strong>安装前注意</strong>
            <span v-for="warning in plan.warnings" :key="warning">{{
              warning
            }}</span>
          </div>
        </div>

        <div class="environment-plan-steps">
          <article v-for="step in reviewSteps" :key="step.stepId">
            <div class="environment-plan-step-head">
              <strong>{{ step.displayName }}</strong>
              <code>{{ step.version || '固定版本' }}</code>
            </div>
            <dl>
              <div>
                <dt>来源</dt>
                <dd>{{ step.publisher || step.sourceUrl }}</dd>
              </div>
              <div>
                <dt>体积</dt>
                <dd>{{ formatEnvironmentBytes(step.estimatedBytes) }}</dd>
              </div>
              <div>
                <dt>策略</dt>
                <dd>{{ step.strategy }}</dd>
              </div>
              <div>
                <dt>权限</dt>
                <dd>
                  {{ step.requiresElevation ? '需要系统授权' : '用户级' }}
                </dd>
              </div>
            </dl>
            <p v-if="!step.cancellable" class="environment-noncancellable">
              <ShieldAlert :size="14" />
              启动系统安装器后，此步骤不能由 Emperor 强制取消
            </p>
          </article>
        </div>

        <div class="environment-license-list">
          <label v-for="license in requiredLicenses" :key="license.id">
            <input
              type="checkbox"
              :checked="licenseChecked(license.id)"
              @change="
                setLicense(
                  license.id,
                  ($event.target as HTMLInputElement).checked,
                )
              "
            />
            <span>接受 {{ license.name }}（{{ license.spdx }}）</span>
            <a :href="license.url" target="_blank" rel="noreferrer">查看</a>
          </label>
          <label
            v-if="needsSeparateConfirmation"
            class="environment-second-confirm"
          >
            <input v-model="separateConfirmed" type="checkbox" />
            <span>我确认单独安装 MSVC Build Tools，并允许系统授权提示</span>
          </label>
        </div>

        <footer>
          <button class="tool-button" @click="closePlan">取消</button>
          <button
            class="tool-button ink"
            :disabled="!canInstallPlan"
            data-testid="confirm-environment-install"
            @click="confirmInstall"
          >
            <Download :size="15" />
            确认并安装
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.environment-diagnostics,
.environment-sections,
.environment-tool-group,
.environment-tool-list,
.environment-history {
  display: grid;
  gap: 8px;
}

.environment-head > div:first-child,
.environment-progress-head > div,
.environment-actions,
.environment-tool-tail,
.environment-job-error,
.environment-logs summary {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.environment-head > div:first-child span {
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-xs);
}

.environment-actions .icon-button {
  width: 32px;
  height: 32px;
}

.environment-error,
.environment-progress,
.environment-empty,
.environment-plan-warnings {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  padding: var(--space-3) 12px;
  background: rgb(var(--bg-elevated));
}

.environment-error {
  border-color: rgb(var(--danger) / 0.45);
}

.environment-error > svg,
.environment-job-error > svg {
  color: rgb(var(--danger));
}

.environment-error div,
.environment-plan-warnings div {
  display: grid;
  gap: 2px;
}

.environment-error span,
.environment-plan-warnings span {
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-sm);
}

.environment-progress {
  grid-template-columns: minmax(0, 1fr);
}

.environment-progress-head {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.environment-progress-head span {
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-sm);
}

.environment-progress-track {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgb(var(--bg-inset));
}

.environment-progress-track span {
  display: block;
  height: 100%;
  background: rgb(var(--accent));
  transition: width 180ms ease;
}

.environment-empty {
  grid-template-columns: 20px minmax(0, 1fr);
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-sm);
}

.environment-tool-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 2px;
}

.environment-tool-group-head strong {
  color: rgb(var(--fg));
  font-size: var(--font-size-sm);
}

.environment-tool-group-head span {
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-xs);
}

.environment-tool-row {
  min-height: 60px;
}

.environment-tool-row > div:nth-child(2) {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.environment-tool-row small {
  overflow: hidden;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.environment-tool-row.tone-ok > svg {
  color: rgb(var(--success));
}

.environment-tool-row.tone-warn > svg {
  color: rgb(var(--warning));
}

.environment-tool-row.tone-error > svg {
  color: rgb(var(--danger));
}

.environment-tool-row.tone-running > svg {
  color: rgb(var(--accent));
}

.environment-tool-tail {
  justify-content: flex-end;
}

.environment-skill-list,
.environment-job-detail,
.environment-log-list {
  display: grid;
  border-top: 1px solid rgb(var(--border));
}

.environment-skill-row,
.environment-job-step,
.environment-job-error {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  min-height: 42px;
  border-bottom: 1px solid rgb(var(--border));
  padding: var(--space-2) 4px;
}

.environment-skill-row > div {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.environment-skill-row span {
  overflow: hidden;
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.environment-job-tabs {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  padding-bottom: 2px;
}

.environment-job-tabs button {
  display: grid;
  flex: 0 0 auto;
  gap: 2px;
  min-width: 132px;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  padding: var(--space-2) 9px;
  background: rgb(var(--bg-elevated));
  color: rgb(var(--fg));
  text-align: left;
}

.environment-job-tabs button.active {
  border-color: rgb(var(--accent) / 0.55);
  background: rgb(var(--accent) / 0.1);
}

.environment-job-tabs code,
.environment-job-step code,
.environment-job-error code {
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-2xs);
}

.environment-job-step {
  grid-template-columns: minmax(0, 1fr) auto;
}

.environment-logs {
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  background: rgb(var(--bg-elevated));
}

.environment-logs summary {
  min-height: 40px;
  cursor: pointer;
  padding: 8px 10px;
  color: rgb(var(--fg-muted));
  list-style: none;
}

.environment-logs summary span {
  flex: 1;
}

.environment-log-list {
  max-height: 260px;
  overflow: auto;
  border-top: 1px solid rgb(var(--border));
}

.environment-log-list > div {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 8px;
  border-bottom: 1px solid rgb(var(--border));
  padding: var(--space-2) 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--font-size-2xs);
}

.environment-log-list > div code {
  grid-column: 2;
  overflow-wrap: anywhere;
  color: rgb(var(--fg-subtle));
  white-space: normal;
}

.environment-log-list p {
  padding: var(--space-3);
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-xs);
}

.environment-more {
  margin: 8px 10px;
}

.environment-confirm-modal {
  display: flex;
  width: min(620px, calc(100vw - 24px));
  max-height: min(760px, calc(100dvh - 24px));
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  padding: var(--space-4);
  background: rgb(var(--bg));
  box-shadow: 0 18px 48px rgb(var(--shadow-color) / 0.32);
}

.environment-confirm-modal > header,
.environment-confirm-modal > footer,
.environment-plan-step-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.environment-confirm-modal h2 {
  color: rgb(var(--fg));
  font-size: var(--font-size-lg);
  font-weight: 700;
}

.environment-confirm-modal header p {
  margin-top: 2px;
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-xs);
}

.environment-plan-warnings {
  grid-template-columns: 20px minmax(0, 1fr);
  border-color: rgb(var(--warning) / 0.4);
}

.environment-plan-warnings > svg,
.environment-noncancellable > svg {
  color: rgb(var(--warning));
}

.environment-plan-steps,
.environment-license-list {
  display: grid;
  gap: 8px;
}

.environment-plan-steps article {
  display: grid;
  gap: 8px;
  border-top: 1px solid rgb(var(--border));
  padding-top: var(--space-3);
}

.environment-plan-steps dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) 12px;
}

.environment-plan-steps dl > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.environment-plan-steps dt {
  color: rgb(var(--fg-subtle));
  font-size: var(--font-size-2xs);
}

.environment-plan-steps dd {
  overflow: hidden;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.environment-noncancellable {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: rgb(var(--warning));
  font-size: var(--font-size-xs);
}

.environment-license-list label {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}

.environment-license-list a {
  color: rgb(var(--accent));
}

.environment-second-confirm {
  border-top: 1px solid rgb(var(--border));
  padding-top: var(--space-2);
}

.environment-confirm-modal > footer {
  position: sticky;
  bottom: -14px;
  border-top: 1px solid rgb(var(--border));
  padding: var(--space-3) 0 14px;
  background: rgb(var(--bg));
}

.environment-confirm-modal > footer .tool-button:last-child {
  margin-left: auto;
}

.spinning {
  animation: environment-spin 900ms linear infinite;
}

@keyframes environment-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinning,
  .environment-progress-track span {
    animation: none;
    transition: none;
  }
}

@media (max-width: 640px) {
  .environment-head,
  .environment-progress-head {
    align-items: stretch;
    flex-direction: column;
  }

  .environment-actions {
    width: 100%;
  }

  .environment-actions .tool-button {
    min-width: 0;
    flex: 1;
  }

  .environment-tool-row {
    grid-template-columns: 20px minmax(0, 1fr);
  }

  .environment-tool-tail {
    grid-column: 2;
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .environment-error {
    grid-template-columns: 20px minmax(0, 1fr);
  }

  .environment-error .tool-button {
    grid-column: 2;
    justify-self: start;
  }

  .environment-plan-steps dl {
    grid-template-columns: minmax(0, 1fr);
  }

  .environment-confirm-modal {
    max-height: calc(100dvh - 16px);
    width: calc(100vw - 16px);
  }
}
</style>
