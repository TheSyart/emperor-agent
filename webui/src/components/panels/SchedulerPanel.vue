<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type { SchedulerJob, SchedulerPayload, SchedulerSchedule } from '../../types'
import { navAssets, toolIcon } from '../../assets'

const ctx = useAppContext()
const selectedId = ref('')
const loading = ref(false)
const createName = ref('')
const createKind = ref<'agent_turn' | 'team_wake'>('agent_turn')
const createMessage = ref('')
const createTarget = ref('')
const createDeliver = ref(true)
const createDeleteAfterRun = ref(false)
const scheduleKind = ref<'at' | 'every' | 'cron'>('every')
const atLocal = ref('')
const everyMinutes = ref(60)
const cronExpr = ref('0 9 * * *')
const cronTz = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
const editName = ref('')
const editMessage = ref('')
const editTarget = ref('')
const editDeliver = ref(true)

const scheduler = computed<SchedulerPayload>(() => ctx.boot.value?.scheduler || {
  status: { running: false, jobs: 0, enabled: 0, nextRunAtMs: null, lastError: null },
  jobs: [],
})
const jobs = computed(() => scheduler.value.jobs || [])
const selected = computed(() => jobs.value.find((job) => job.id === selectedId.value) || jobs.value[0] || null)
const runHistory = computed(() => {
  if (selected.value?.state?.runHistory?.length) return [...selected.value.state.runHistory].reverse()
  return jobs.value
    .flatMap((job) => (job.state?.runHistory || []).map((run) => ({ ...run, jobName: job.name, jobId: job.id })))
    .sort((a, b) => Number(b.runAtMs || 0) - Number(a.runAtMs || 0))
    .slice(0, 40)
})
const enabledCount = computed(() => scheduler.value.status?.enabled || 0)
const nextRunLabel = computed(() => formatMs(scheduler.value.status?.nextRunAtMs))

watch(jobs, () => {
  if (!selectedId.value && jobs.value.length) selectedId.value = jobs.value[0].id
  if (selectedId.value && !jobs.value.some((job) => job.id === selectedId.value)) selectedId.value = jobs.value[0]?.id || ''
}, { immediate: true })

watch(selected, (job) => {
  editName.value = job?.name || ''
  editMessage.value = job?.payload?.message || ''
  editTarget.value = job?.payload?.target || ''
  editDeliver.value = job?.payload?.deliver !== false
}, { immediate: true })

async function refreshScheduler() {
  loading.value = true
  try {
    const payload = await api<SchedulerPayload>('/api/scheduler')
    if (ctx.boot.value) ctx.boot.value.scheduler = payload
  } finally {
    loading.value = false
  }
}

async function createJob() {
  if (!createMessage.value.trim()) return
  loading.value = true
  try {
    const result = await api<{ job: SchedulerJob; scheduler: SchedulerPayload }>('/api/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({
        name: createName.value.trim() || defaultJobName(),
        schedule: buildCreateSchedule(),
        payload: {
          kind: createKind.value,
          message: createMessage.value.trim(),
          target: createKind.value === 'team_wake' ? createTarget.value.trim() : null,
          deliver: createDeliver.value,
        },
        deleteAfterRun: createDeleteAfterRun.value,
      }),
    })
    if (ctx.boot.value) ctx.boot.value.scheduler = result.scheduler
    selectedId.value = result.job.id
    createName.value = ''
    createMessage.value = ''
    createTarget.value = ''
    ctx.showToast(`定时任务已创建：${result.job.name}`)
  } finally {
    loading.value = false
  }
}

async function saveSelected() {
  if (!selected.value) return
  loading.value = true
  try {
    const result = await api<{ job: SchedulerJob; scheduler: SchedulerPayload }>(
      `/api/scheduler/jobs/${encodeURIComponent(selected.value.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.value.trim() || selected.value.name,
          payload: {
            ...selected.value.payload,
            message: editMessage.value.trim(),
            target: selected.value.payload.kind === 'team_wake' ? editTarget.value.trim() : null,
            deliver: editDeliver.value,
          },
        }),
      },
    )
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
  if (!selected.value || selected.value.protected) return
  if (!window.confirm(`删除定时任务「${selected.value.name}」？`)) return
  loading.value = true
  try {
    const result = await api<{ deleted: string; scheduler: SchedulerPayload }>(
      `/api/scheduler/jobs/${encodeURIComponent(selected.value.id)}`,
      { method: 'DELETE' },
    )
    if (ctx.boot.value) ctx.boot.value.scheduler = result.scheduler
    selectedId.value = jobs.value[0]?.id || ''
    ctx.showToast('定时任务已删除')
  } finally {
    loading.value = false
  }
}

async function schedulerAction(job: SchedulerJob, action: 'run' | 'pause' | 'resume', toast: string) {
  loading.value = true
  try {
    const result = await api<{ scheduler: SchedulerPayload }>(
      `/api/scheduler/jobs/${encodeURIComponent(job.id)}/${action}`,
      { method: 'POST', body: JSON.stringify({}) },
    )
    if (ctx.boot.value) ctx.boot.value.scheduler = result.scheduler
    ctx.showToast(toast)
  } finally {
    loading.value = false
  }
}

function buildCreateSchedule(): SchedulerSchedule {
  if (scheduleKind.value === 'at') {
    return { kind: 'at', atMs: atLocal.value ? new Date(atLocal.value).getTime() : Date.now() + 60 * 60 * 1000 }
  }
  if (scheduleKind.value === 'cron') {
    return { kind: 'cron', expr: cronExpr.value.trim() || '0 9 * * *', tz: cronTz.value.trim() || 'UTC' }
  }
  return { kind: 'every', everyMs: Math.max(1, Number(everyMinutes.value || 1)) * 60 * 1000 }
}

function defaultJobName() {
  return createKind.value === 'team_wake' ? '唤醒队友' : '主 Agent 任务'
}

function scheduleLabel(job: SchedulerJob) {
  const schedule = job.schedule || { kind: 'every' }
  if (schedule.kind === 'at') return `指定时间：${formatMs(schedule.atMs)}`
  if (schedule.kind === 'cron') return `Cron：${schedule.expr || '-'} · ${schedule.tz || '本地时区'}`
  return `每隔 ${formatDuration(schedule.everyMs || 0)}`
}

function payloadLabel(job: SchedulerJob) {
  if (job.payload.kind === 'team_wake') return `唤醒队友 · ${job.payload.target || '-'}`
  if (job.payload.kind === 'system_event') return '系统事件'
  return '主 Agent 任务'
}

function statusLabel(job: SchedulerJob) {
  if (!job.enabled) return '已暂停'
  if (job.state?.lastStatus === 'error') return '异常'
  if (job.protected) return '受保护'
  return '已启用'
}

function statusClass(job: SchedulerJob) {
  return ['scheduler-job-row', { active: job.id === selected.value?.id, paused: !job.enabled, error: job.state?.lastStatus === 'error' }]
}

function runStatusLabel(status?: string) {
  if (status === 'ok') return '成功'
  if (status === 'error') return '失败'
  if (status === 'skipped') return '已跳过'
  if (status === 'cancelled') return '已取消'
  if (status === 'running') return '运行中'
  return status || '-'
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
</script>

<template>
  <div class="panel-content scheduler-panel">
    <div class="scheduler-layout">
      <section class="scheduler-roster">
        <div class="team-section-head">
          <div>
            <h2>任务</h2>
            <p>{{ jobs.length }} 个任务 · {{ enabledCount }} 个已启用</p>
          </div>
          <button class="icon-button" title="刷新" :disabled="loading" @click="refreshScheduler">↻</button>
        </div>

        <div class="scheduler-summary">
          <div>
            <span>下次运行</span>
            <strong>{{ nextRunLabel }}</strong>
          </div>
          <div>
            <span>服务状态</span>
            <strong>{{ scheduler.status.running ? '运行中' : '已停止' }}</strong>
          </div>
        </div>

        <div class="scheduler-job-list">
          <button
            v-for="job in jobs"
            :key="job.id"
            :class="statusClass(job)"
            @click="selectedId = job.id"
          >
            <img class="scheduler-job-icon" :src="navAssets.schedulerActive" alt="" width="42" height="42" />
            <span class="min-w-0 flex-1">
              <strong>{{ job.name }}</strong>
              <small>{{ scheduleLabel(job) }}</small>
              <small>{{ payloadLabel(job) }}</small>
            </span>
            <em>{{ statusLabel(job) }}</em>
          </button>
          <div v-if="!jobs.length" class="scheduler-empty">还没有定时任务。</div>
        </div>

        <form class="scheduler-create" @submit.prevent="createJob">
          <div class="team-form-row">
            <input v-model="createName" placeholder="任务名称" autocomplete="off" />
            <select v-model="createKind">
              <option value="agent_turn">主 Agent 任务</option>
              <option value="team_wake">唤醒队友</option>
            </select>
          </div>
          <textarea v-model="createMessage" rows="3" placeholder="任务内容 / 提示词" />
          <input v-if="createKind === 'team_wake'" v-model="createTarget" placeholder="队友名称" autocomplete="off" />
          <div class="team-form-row">
            <select v-model="scheduleKind">
              <option value="every">每隔</option>
              <option value="at">指定时间</option>
              <option value="cron">Cron 表达式</option>
            </select>
            <input v-if="scheduleKind === 'every'" v-model.number="everyMinutes" min="1" type="number" />
            <input v-else-if="scheduleKind === 'at'" v-model="atLocal" type="datetime-local" />
            <input v-else v-model="cronExpr" placeholder="0 9 * * *" />
          </div>
          <input v-if="scheduleKind === 'cron'" v-model="cronTz" placeholder="Asia/Shanghai" />
          <label class="scheduler-check"><input v-model="createDeliver" type="checkbox" /> 将运行结果显示到当前对话</label>
          <label class="scheduler-check"><input v-model="createDeleteAfterRun" type="checkbox" /> 一次性任务运行后删除</label>
          <button class="tool-button wide ink" :disabled="loading || !createMessage.trim()">创建任务</button>
        </form>
      </section>

      <section class="scheduler-timeline">
        <div class="team-section-head">
          <div>
            <h2>{{ selected?.name || '运行历史' }}</h2>
            <p>{{ selected ? `${selected.id} · ${payloadLabel(selected)}` : '最近运行记录' }}</p>
          </div>
          <span v-if="selected" class="team-status-pill" :class="{ working: selected.enabled, error: selected.state?.lastStatus === 'error' }">
            {{ statusLabel(selected) }}
          </span>
        </div>

        <div class="scheduler-run-scroll">
          <article
            v-for="run in runHistory"
            :key="`${run.runAtMs}-${run.status}-${run.error || ''}`"
            class="scheduler-run"
            :class="run.status"
          >
            <div class="team-message-top">
              <strong>{{ 'jobName' in run ? run.jobName : selected?.name || '定时任务' }}</strong>
              <span>{{ formatMs(run.runAtMs) }}</span>
            </div>
            <p>{{ runStatusLabel(run.status) }} · {{ formatDuration(run.durationMs) }}</p>
            <small v-if="run.error">{{ run.error }}</small>
          </article>
          <div v-if="!runHistory.length" class="team-empty">
            <img :src="navAssets.schedulerActive" alt="" width="96" height="96" />
            <span>尚无运行记录。</span>
          </div>
        </div>
      </section>

      <aside class="scheduler-detail">
        <div class="team-section-head">
          <div>
            <h2>任务详情</h2>
            <p>{{ selected ? scheduleLabel(selected) : '选择一个任务' }}</p>
          </div>
        </div>

        <div v-if="selected" class="scheduler-detail-body">
          <div class="team-stamp">
            <img :src="navAssets.schedulerActive" alt="" width="64" height="64" />
            <div class="min-w-0">
              <strong>{{ selected.name }}</strong>
              <span>{{ selected.protected ? '受保护任务' : selected.id }}</span>
            </div>
          </div>

          <div class="scheduler-meta-grid">
            <span><b>计划</b>{{ scheduleLabel(selected) }}</span>
            <span><b>载荷</b>{{ payloadLabel(selected) }}</span>
            <span><b>下次</b>{{ formatMs(selected.state?.nextRunAtMs) }}</span>
            <span><b>上次</b>{{ runStatusLabel(selected.state?.lastStatus || undefined) }}</span>
          </div>

          <input v-model="editName" autocomplete="off" />
          <textarea v-model="editMessage" rows="5" placeholder="任务内容" />
          <input v-if="selected.payload.kind === 'team_wake'" v-model="editTarget" autocomplete="off" placeholder="队友名称" />
          <label class="scheduler-check"><input v-model="editDeliver" type="checkbox" /> 将运行结果显示到当前对话</label>

          <div class="team-tool-cloud">
            <span><img :src="toolIcon('scheduler')" alt="" width="18" height="18" /> 定时任务</span>
            <span>{{ selected.deleteAfterRun ? '运行后删除' : '持续保留' }}</span>
            <span>{{ payloadLabel(selected) }}</span>
          </div>

          <div class="scheduler-action-grid">
            <button class="tool-button ink" :disabled="loading || selected.protected" @click="saveSelected">保存</button>
            <button class="tool-button" :disabled="loading" @click="runSelected">运行</button>
            <button v-if="selected.enabled" class="tool-button" :disabled="loading" @click="pauseSelected">暂停</button>
            <button v-else class="tool-button" :disabled="loading" @click="resumeSelected">恢复</button>
            <button class="tool-button danger" :disabled="loading || selected.protected" @click="deleteSelected">删除</button>
          </div>

          <div v-if="selected.state?.lastError" class="team-error">{{ selected.state.lastError }}</div>
        </div>

        <div v-else class="scheduler-detail-body muted">
          <p>还没有登记定时任务。</p>
        </div>
      </aside>
    </div>
  </div>
</template>
