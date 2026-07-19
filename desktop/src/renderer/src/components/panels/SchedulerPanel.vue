<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type {
  SchedulerJob,
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerRunRecord,
  SchedulerSchedule,
} from '../../types'
import { actionIcons, navIcon, toolIcon } from '../../icons'
import {
  canEditSchedulerJob,
  schedulerMisfirePolicyLabel,
  schedulerMisfirePolicyOptions,
  schedulerRunStatusLabel,
} from './schedulerPanelModel'

const ctx = useAppContext()
const selectedId = ref('')
const loading = ref(false)
const createOpen = ref(false)

const createName = ref('')
const createMessage = ref('')
const createDeliver = ref(true)
const createDeleteAfterRun = ref(false)
const createMisfirePolicy = ref<SchedulerMisfirePolicy>('skip')
const createScheduleKind = ref<'at' | 'every' | 'cron'>('every')
const createAtLocal = ref('')
const createEveryMinutes = ref(60)
const createCronExpr = ref('0 9 * * *')
const createCronTz = ref(
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
)

const editName = ref('')
const editMessage = ref('')
const editDeliver = ref(true)
const editDeleteAfterRun = ref(false)
const editMisfirePolicy = ref<SchedulerMisfirePolicy>('skip')
const editScheduleKind = ref<'at' | 'every' | 'cron'>('every')
const editAtLocal = ref('')
const editEveryMinutes = ref(60)
const editCronExpr = ref('0 9 * * *')
const editCronTz = ref(
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
)

const scheduler = computed<SchedulerPayload>(
  () =>
    ctx.boot.value?.scheduler || {
      status: {
        running: false,
        jobs: 0,
        enabled: 0,
        nextRunAtMs: null,
        lastError: null,
      },
      jobs: [],
    },
)
const jobs = computed(() => scheduler.value.jobs || [])
const selected = computed(
  () => jobs.value.find((job) => job.id === selectedId.value) || null,
)
const selectedCanEdit = computed(() => canEditSchedulerJob(selected.value))
const selectedRunHistory = computed(() =>
  [...(selected.value?.state?.runHistory || [])].reverse(),
)
const enabledCount = computed(() => scheduler.value.status?.enabled || 0)
const nextRunLabel = computed(() =>
  formatMs(scheduler.value.status?.nextRunAtMs),
)
const misfireOptions = schedulerMisfirePolicyOptions()

watch(
  jobs,
  () => {
    if (
      selectedId.value &&
      !jobs.value.some((job) => job.id === selectedId.value)
    ) {
      selectedId.value = ''
    }
  },
  { immediate: true },
)

watch(
  selected,
  (job) => {
    if (!job) return
    editName.value = job.name || ''
    editMessage.value = job.payload?.message || ''
    editDeliver.value = job.payload?.deliver !== false
    editDeleteAfterRun.value = Boolean(job.deleteAfterRun)
    editMisfirePolicy.value = job.misfirePolicy || 'skip'
    setScheduleDraft(job.schedule, 'edit')
  },
  { immediate: true },
)

defineExpose({ openCreate })

function openCreate() {
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

function resetCreateForm() {
  createName.value = ''
  createMessage.value = ''
  createDeliver.value = true
  createDeleteAfterRun.value = false
  createMisfirePolicy.value = 'skip'
  createScheduleKind.value = 'every'
  createAtLocal.value = ''
  createEveryMinutes.value = 60
  createCronExpr.value = '0 9 * * *'
  createCronTz.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function selectJob(job: SchedulerJob) {
  selectedId.value = job.id
}

function backToList() {
  selectedId.value = ''
}

async function refreshScheduler() {
  loading.value = true
  try {
    const payload = await core('scheduler.get')
    if (ctx.boot.value) ctx.boot.value.scheduler = payload
  } finally {
    loading.value = false
  }
}

async function createJob() {
  if (!createMessage.value.trim()) return
  loading.value = true
  try {
    const result = await core('scheduler.createJob', {
      name: createName.value.trim() || defaultJobName(),
      schedule: buildSchedule(
        createScheduleKind.value,
        createAtLocal.value,
        createEveryMinutes.value,
        createCronExpr.value,
        createCronTz.value,
      ),
      payload: {
        kind: 'agent_turn',
        message: createMessage.value.trim(),
        target: null,
        deliver: createDeliver.value,
      },
      deleteAfterRun: createDeleteAfterRun.value,
      misfirePolicy: createMisfirePolicy.value,
    })
    if (ctx.boot.value) ctx.boot.value.scheduler = result.scheduler
    selectedId.value = result.job.id
    closeCreate()
    resetCreateForm()
    ctx.showToast(`定时任务已创建：${result.job.name}`)
  } finally {
    loading.value = false
  }
}

async function saveSelected() {
  if (!selected.value || !selectedCanEdit.value) return
  loading.value = true
  try {
    const result = await core('scheduler.updateJob', selected.value.id, {
      name: editName.value.trim() || selected.value.name,
      schedule: buildSchedule(
        editScheduleKind.value,
        editAtLocal.value,
        editEveryMinutes.value,
        editCronExpr.value,
        editCronTz.value,
      ),
      payload: editablePayload(selected.value),
      deleteAfterRun: editDeleteAfterRun.value,
      misfirePolicy: editMisfirePolicy.value,
    })
    if (ctx.boot.value) ctx.boot.value.scheduler = result.scheduler
    ctx.showToast('定时任务已保存')
  } finally {
    loading.value = false
  }
}

async function runSelected() {
  if (!selected.value) return
  await schedulerAction(selected.value, 'run', '已手动运行任务')
}

async function pauseSelected() {
  if (!selected.value) return
  await schedulerAction(selected.value, 'pause', '任务已暂停')
}

async function resumeSelected() {
  if (!selected.value) return
  await schedulerAction(selected.value, 'resume', '任务已恢复')
}

async function deleteSelected() {
  if (!selected.value || !selectedCanEdit.value) return
  if (!window.confirm(`删除定时任务「${selected.value.name}」？`)) return
  loading.value = true
  try {
    const result = await core('scheduler.deleteJob', selected.value.id)
    if (ctx.boot.value) ctx.boot.value.scheduler = result.scheduler
    selectedId.value = ''
    ctx.showToast('定时任务已删除')
  } finally {
    loading.value = false
  }
}

async function schedulerAction(
  job: SchedulerJob,
  action: 'run' | 'pause' | 'resume',
  toast: string,
) {
  loading.value = true
  try {
    const opByAction = {
      run: 'scheduler.runJob',
      pause: 'scheduler.pauseJob',
      resume: 'scheduler.resumeJob',
    } as const
    const result = await core(opByAction[action], job.id)
    if (ctx.boot.value) ctx.boot.value.scheduler = result.scheduler
    ctx.showToast(toast)
  } finally {
    loading.value = false
  }
}

function buildSchedule(
  kind: 'at' | 'every' | 'cron',
  atLocal: string,
  everyMinutes: number,
  cronExpr: string,
  cronTz: string,
):
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; everyMs: number }
  | { kind: 'cron'; expr: string; tz: string } {
  if (kind === 'at') {
    return {
      kind: 'at',
      atMs: atLocal ? new Date(atLocal).getTime() : Date.now() + 60 * 60 * 1000,
    }
  }
  if (kind === 'cron') {
    return {
      kind: 'cron',
      expr: cronExpr.trim() || '0 9 * * *',
      tz: cronTz.trim() || 'UTC',
    }
  }
  return {
    kind: 'every',
    everyMs: Math.max(1, Number(everyMinutes || 1)) * 60 * 1000,
  }
}

function editablePayload(job: SchedulerJob) {
  if (job.payload.kind === 'team_wake') {
    return {
      kind: 'team_wake' as const,
      message: editMessage.value.trim(),
      target: String(job.payload.target || ''),
      projectId: String(job.payload.projectId || ''),
      deliver: editDeliver.value,
      meta: job.payload.meta,
    }
  }
  return {
    kind: 'agent_turn' as const,
    message: editMessage.value.trim(),
    target: null,
    projectId: job.payload.projectId,
    deliver: editDeliver.value,
    meta: job.payload.meta,
  }
}

function setScheduleDraft(
  schedule: SchedulerSchedule | undefined,
  target: 'edit',
) {
  const current = schedule || { kind: 'every', everyMs: 60 * 60 * 1000 }
  const kind =
    current.kind === 'at' || current.kind === 'cron' ? current.kind : 'every'
  if (target === 'edit') {
    editScheduleKind.value = kind
    editAtLocal.value = current.atMs ? toLocalInputValue(current.atMs) : ''
    editEveryMinutes.value = Math.max(
      1,
      Math.round(Number(current.everyMs || 60 * 60 * 1000) / 60_000),
    )
    editCronExpr.value = current.expr || '0 9 * * *'
    editCronTz.value =
      current.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
}

function defaultJobName() {
  return '主 Agent 任务'
}

function scheduleLabel(job: SchedulerJob) {
  const schedule = job.schedule || { kind: 'every' }
  if (schedule.kind === 'at') return `指定时间：${formatMs(schedule.atMs)}`
  if (schedule.kind === 'cron')
    return `Cron：${schedule.expr || '-'} · ${schedule.tz || '本地时区'}`
  return `每隔 ${formatDuration(schedule.everyMs || 0)}`
}

function payloadLabel(job: SchedulerJob) {
  if (job.payload.kind === 'team_wake')
    return `唤醒队友 · ${job.payload.target || '-'}`
  if (job.payload.kind === 'system_event') return '系统事件'
  return '主 Agent 任务'
}

function statusLabel(job: SchedulerJob) {
  if (job.state?.activeRun?.phase === 'running') return '运行中'
  if (job.state?.activeRun?.phase === 'queued') return '排队中'
  if (!job.enabled) return '已暂停'
  if (job.state?.lastStatus === 'error') return '异常'
  if (job.protected) return '受保护'
  return '已启用'
}

function statusClass(job: SchedulerJob) {
  return [
    'scheduler-table-row',
    {
      active: job.id === selected.value?.id,
      paused: !job.enabled,
      error: job.state?.lastStatus === 'error',
    },
  ]
}

function runStatusLabel(status?: string | null) {
  return schedulerRunStatusLabel(status)
}

function runKey(run: SchedulerRunRecord) {
  return (
    run.runId ||
    `${run.runAtMs}-${run.status}-${run.durationMs || 0}-${run.error || ''}`
  )
}

function policyLabel(policy?: SchedulerMisfirePolicy) {
  return schedulerMisfirePolicyLabel(policy)
}

function formatDuration(ms?: number) {
  const value = Math.max(0, Number(ms || 0))
  if (value >= 60_000) return `${Math.round(value / 60_000)} 分钟`
  if (value >= 1000) return `${Math.round(value / 1000)} 秒`
  return `${value} 毫秒`
}

function formatMs(ms?: number | null) {
  if (!ms) return '-'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function toLocalInputValue(ms: number) {
  const date = new Date(ms)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}
</script>

<template>
  <div class="panel-content scheduler-panel scheduler-panel-v2">
    <div class="scheduler-overview">
      <span
        ><b>{{ jobs.length }}</b
        >任务</span
      >
      <span
        ><b>{{ enabledCount }}</b
        >已启用</span
      >
      <span
        ><b>{{ scheduler.status.running ? '运行中' : '已停止' }}</b
        >服务状态</span
      >
      <span
        ><b>{{ nextRunLabel }}</b
        >下次运行</span
      >
      <span
        ><b
          >{{ scheduler.status.active || 0 }}/{{
            scheduler.status.queued || 0
          }}/{{ scheduler.status.maxConcurrentRuns || 2 }}</b
        >运行 / 排队 / 上限</span
      >
      <span
        ><b>{{ scheduler.status.maxPerOwner || 1 }}</b
        >同一会话上限</span
      >
      <button
        class="tool-button asset-button compact"
        :disabled="loading"
        @click="refreshScheduler"
      >
        <component :is="actionIcons.refresh" class="action-icon" :size="15" />
        <span>刷新列表</span>
      </button>
    </div>
    <p class="empty-note scheduler-runtime-note">
      关闭应用时取消并中断运行；重启只恢复已持久排队的任务，不自动重放未确认完成的运行。启动期间无论错过多少次，最多补跑一次。
    </p>

    <div v-if="!selected" class="scheduler-workspace">
      <section class="scheduler-list-shell">
        <div class="scheduler-table-head">
          <span>任务</span>
          <span>计划</span>
          <span>载荷</span>
          <span>下次运行</span>
          <span>上次状态</span>
          <span>状态</span>
        </div>

        <div class="scheduler-table-scroll">
          <button
            v-for="job in jobs"
            :key="job.id"
            :class="statusClass(job)"
            @click="selectJob(job)"
          >
            <span class="scheduler-cell-main">
              <component
                :is="navIcon('scheduler')"
                class="scheduler-inline-icon"
                :size="18"
              />
              <span class="min-w-0">
                <strong>{{ job.name }}</strong>
                <small>{{ job.id }}</small>
              </span>
            </span>
            <span>{{ scheduleLabel(job) }}</span>
            <span>{{ payloadLabel(job) }}</span>
            <span>{{ formatMs(job.state?.nextRunAtMs) }}</span>
            <span>{{
              runStatusLabel(job.state?.lastStatus || undefined)
            }}</span>
            <span class="scheduler-status-wrap">
              <em>{{ statusLabel(job) }}</em>
              <em v-if="job.deleteAfterRun">一次性</em>
            </span>
          </button>

          <div v-if="!jobs.length" class="scheduler-empty">
            还没有定时任务。点击右上角“新增任务”创建第一个任务。
          </div>
        </div>
      </section>
    </div>

    <section v-else class="scheduler-detail-page">
      <div class="scheduler-drawer-head scheduler-detail-page-head">
        <button
          class="tool-button asset-button"
          type="button"
          @click="backToList"
        >
          返回任务列表
        </button>
        <div>
          <h2>{{ selected?.name || '任务详情' }}</h2>
          <p>
            {{ selected ? scheduleLabel(selected) : '选择一个任务查看详情' }}
          </p>
        </div>
      </div>

      <form
        v-if="selected"
        class="scheduler-detail-body"
        @submit.prevent="saveSelected"
      >
        <div class="team-stamp">
          <component
            :is="navIcon('scheduler')"
            :size="38"
            :stroke-width="1.5"
          />
          <div class="min-w-0">
            <strong>{{ selected.name }}</strong>
            <span>{{ selected.protected ? '受保护任务' : selected.id }}</span>
          </div>
        </div>

        <div class="scheduler-meta-grid">
          <span><b>下次</b>{{ formatMs(selected.state?.nextRunAtMs) }}</span>
          <span
            ><b>上次</b
            >{{ runStatusLabel(selected.state?.lastStatus || undefined) }}</span
          >
          <span><b>创建</b>{{ formatMs(selected.createdAtMs) }}</span>
          <span><b>更新</b>{{ formatMs(selected.updatedAtMs) }}</span>
          <span><b>错过策略</b>{{ policyLabel(selected.misfirePolicy) }}</span>
        </div>

        <label class="scheduler-field">
          <span>任务名称</span>
          <input
            v-model="editName"
            autocomplete="off"
            :disabled="!selectedCanEdit"
          />
        </label>
        <label class="scheduler-field">
          <span>任务内容 / 提示词</span>
          <textarea
            v-model="editMessage"
            rows="5"
            :disabled="!selectedCanEdit"
          />
        </label>

        <div class="scheduler-form-grid">
          <label class="scheduler-field">
            <span>计划类型</span>
            <select v-model="editScheduleKind" :disabled="!selectedCanEdit">
              <option value="every">每隔</option>
              <option value="at">指定时间</option>
              <option value="cron">Cron 表达式</option>
            </select>
          </label>
          <label v-if="editScheduleKind === 'every'" class="scheduler-field">
            <span>间隔分钟</span>
            <input
              v-model.number="editEveryMinutes"
              min="1"
              type="number"
              :disabled="!selectedCanEdit"
            />
          </label>
          <label v-else-if="editScheduleKind === 'at'" class="scheduler-field">
            <span>指定时间</span>
            <input
              v-model="editAtLocal"
              type="datetime-local"
              :disabled="!selectedCanEdit"
            />
          </label>
          <label v-else class="scheduler-field">
            <span>Cron</span>
            <input
              v-model="editCronExpr"
              placeholder="0 9 * * *"
              :disabled="!selectedCanEdit"
            />
          </label>
        </div>

        <label v-if="editScheduleKind === 'cron'" class="scheduler-field">
          <span>时区</span>
          <input
            v-model="editCronTz"
            placeholder="Asia/Shanghai"
            :disabled="!selectedCanEdit"
          />
        </label>

        <label class="scheduler-field">
          <span>应用关闭期间错过计划时</span>
          <select v-model="editMisfirePolicy" :disabled="!selectedCanEdit">
            <option
              v-for="option in misfireOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <p class="empty-note">
          此策略只影响启动恢复；无论错过多少次，单个任务最多进入队列一次。
        </p>

        <label class="scheduler-check">
          <input
            v-model="editDeliver"
            type="checkbox"
            :disabled="!selectedCanEdit"
          />
          将运行结果显示到当前对话
        </label>
        <label class="scheduler-check">
          <input
            v-model="editDeleteAfterRun"
            type="checkbox"
            :disabled="!selectedCanEdit"
          />
          一次性任务运行后删除
        </label>

        <div class="team-tool-cloud">
          <span
            ><component :is="toolIcon('scheduler')" :size="14" /> 定时任务</span
          >
          <span>{{ selected.deleteAfterRun ? '运行后删除' : '持续保留' }}</span>
          <span>{{ payloadLabel(selected) }}</span>
        </div>

        <div class="scheduler-action-grid">
          <button
            class="tool-button ink"
            type="submit"
            :disabled="loading || !selectedCanEdit"
          >
            保存
          </button>
          <button
            class="tool-button"
            type="button"
            :disabled="loading"
            @click="runSelected"
          >
            运行
          </button>
          <button
            v-if="selected.enabled"
            class="tool-button"
            type="button"
            :disabled="loading"
            @click="pauseSelected"
          >
            暂停
          </button>
          <button
            v-else
            class="tool-button"
            type="button"
            :disabled="loading"
            @click="resumeSelected"
          >
            恢复
          </button>
          <button
            class="tool-button danger"
            type="button"
            :disabled="loading || !selectedCanEdit"
            @click="deleteSelected"
          >
            删除
          </button>
        </div>

        <div v-if="selected.state?.lastError" class="team-error">
          {{ selected.state.lastError }}
        </div>

        <section class="scheduler-history-block">
          <div class="scheduler-history-head">
            <strong>运行历史</strong>
            <span>{{ selectedRunHistory.length }} 条</span>
          </div>
          <article
            v-for="run in selectedRunHistory"
            :key="runKey(run)"
            class="scheduler-run compact-run"
            :class="run.status"
          >
            <div class="team-message-top">
              <strong>{{ runStatusLabel(run.status) }}</strong>
              <span>实际 {{ formatMs(run.runAtMs) }}</span>
            </div>
            <p>
              计划 {{ formatMs(run.scheduledForMs || run.runAtMs) }} ·
              {{ formatDuration(run.durationMs) }} ·
              {{ run.missedCount || 1 }} 次计划{{
                run.countCapped ? '（计数已封顶）' : ''
              }}
            </p>
            <small v-if="run.runId"
              >run {{ run.runId }} · task {{ run.taskId || '-' }}</small
            >
            <small v-if="run.error">{{ run.error }}</small>
          </article>
          <div v-if="!selectedRunHistory.length" class="empty-note">
            暂无运行记录。
          </div>
        </section>
      </form>
    </section>

    <div v-if="createOpen" class="modal-backdrop" @click.self="closeCreate">
      <form class="scheduler-modal" @submit.prevent="createJob">
        <div class="scheduler-drawer-head">
          <div>
            <h2>新增定时任务</h2>
            <p>创建一个由本地 Scheduler 触发的 Agent 任务</p>
          </div>
          <button
            class="icon-button"
            type="button"
            title="关闭"
            @click="closeCreate"
          >
            ×
          </button>
        </div>

        <label class="scheduler-field">
          <span>任务名称</span>
          <input
            v-model="createName"
            placeholder="主 Agent 任务"
            autocomplete="off"
          />
        </label>
        <label class="scheduler-field">
          <span>任务内容 / 提示词</span>
          <textarea
            v-model="createMessage"
            rows="4"
            placeholder="描述要推进的任务"
          />
        </label>

        <div class="scheduler-form-grid">
          <label class="scheduler-field">
            <span>计划类型</span>
            <select v-model="createScheduleKind">
              <option value="every">每隔</option>
              <option value="at">指定时间</option>
              <option value="cron">Cron 表达式</option>
            </select>
          </label>
          <label v-if="createScheduleKind === 'every'" class="scheduler-field">
            <span>间隔分钟</span>
            <input v-model.number="createEveryMinutes" min="1" type="number" />
          </label>
          <label
            v-else-if="createScheduleKind === 'at'"
            class="scheduler-field"
          >
            <span>指定时间</span>
            <input v-model="createAtLocal" type="datetime-local" />
          </label>
          <label v-else class="scheduler-field">
            <span>Cron</span>
            <input v-model="createCronExpr" placeholder="0 9 * * *" />
          </label>
        </div>

        <label v-if="createScheduleKind === 'cron'" class="scheduler-field">
          <span>时区</span>
          <input v-model="createCronTz" placeholder="Asia/Shanghai" />
        </label>

        <label class="scheduler-field">
          <span>应用关闭期间错过计划时</span>
          <select v-model="createMisfirePolicy">
            <option
              v-for="option in misfireOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <p class="empty-note">
          最多补跑一次；“只运行最近一次”保留最新计划时间，“补跑最早一次”保留首次错过时间。
        </p>

        <label class="scheduler-check"
          ><input v-model="createDeliver" type="checkbox" />
          将运行结果显示到当前对话</label
        >
        <label class="scheduler-check"
          ><input v-model="createDeleteAfterRun" type="checkbox" />
          一次性任务运行后删除</label
        >

        <div class="scheduler-modal-actions">
          <button class="tool-button" type="button" @click="closeCreate">
            取消
          </button>
          <button
            class="tool-button ink"
            type="submit"
            :disabled="loading || !createMessage.trim()"
          >
            创建任务
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
