<script setup lang="ts">
/**
 * Settings › Scheduler — native section: a one-line service summary, then
 * one expandable card per job (name, schedule · next run, status badge,
 * enable Switch). Opening a card shows its facts, the inline edit form and
 * the run history; 「新增任务」 in the header opens the create form as a card
 * at the top of the list (no nested modal). One header refresh reloads
 * `scheduler.get`. Every mutation replaces `boot.scheduler` with the payload
 * Core returns.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import Button from '../ui/Button.vue'
import { DsPlus } from '../icons/ds'
import {
  EmptyState,
  SettingsCard,
  SettingsGroup,
  SettingsSection,
  StatusBadge,
} from './ui'
import { refreshAction, useSettingsHeader } from './settingsHeader'
import SchedulerJobCard from './scheduler/SchedulerJobCard.vue'
import SchedulerJobForm from './scheduler/SchedulerJobForm.vue'
import {
  canEditSchedulerJob,
  createJobInput,
  emptyJobDraft,
  emptySchedulerPayload,
  schedulerSummary,
  updateJobInput,
  type SchedulerJobDraft,
} from './scheduler/schedulerModel'
import type { SchedulerJob, SchedulerPayload } from '../../types'

const ctx = useAppContext()
const busy = ref(false)
const openId = ref('')
const createOpen = ref(false)
const createDraft = ref<SchedulerJobDraft>(emptyJobDraft())
const createCard = ref<InstanceType<typeof SettingsCard> | null>(null)
const createForm = ref<InstanceType<typeof SchedulerJobForm> | null>(null)

const scheduler = computed<SchedulerPayload>(
  () => ctx.boot.value?.scheduler || emptySchedulerPayload(),
)
const jobs = computed(() => scheduler.value.jobs || [])
const summary = computed(() => schedulerSummary(scheduler.value))
const running = computed(() => Boolean(scheduler.value.status?.running))

watch(
  jobs,
  (list) => {
    if (openId.value && !list.some((job) => job.id === openId.value))
      openId.value = ''
  },
  { immediate: true },
)

useSettingsHeader({
  actions: () => [
    refreshAction(() => refresh(), { title: '刷新定时任务' }),
    {
      id: 'create',
      label: '新增任务',
      kind: 'primary',
      icon: DsPlus,
      disabled: createOpen.value,
      onClick: () => openCreate(),
    },
  ],
})

function apply(payload: SchedulerPayload | undefined) {
  if (ctx.boot.value && payload) ctx.boot.value.scheduler = payload
}

async function request(task: () => Promise<void>) {
  busy.value = true
  try {
    await ctx.runSafely(task)
  } finally {
    busy.value = false
  }
}

function refresh() {
  return request(async () => {
    apply(await core('scheduler.get'))
  })
}

async function openCreate() {
  createOpen.value = true
  await nextTick()
  const card = createCard.value?.$el as HTMLElement | undefined
  card?.scrollIntoView?.({ block: 'nearest' })
  createForm.value?.focus()
}

function closeCreate() {
  createOpen.value = false
  createDraft.value = emptyJobDraft()
}

function createJob() {
  if (!createDraft.value.message.trim()) return
  return request(async () => {
    const result = await core(
      'scheduler.createJob',
      createJobInput(createDraft.value),
    )
    apply(result.scheduler)
    openId.value = result.job.id
    closeCreate()
    ctx.showToast(`定时任务已创建：${result.job.name}`)
  })
}

function saveJob(job: SchedulerJob, draft: SchedulerJobDraft) {
  if (!canEditSchedulerJob(job)) return
  return request(async () => {
    const result = await core(
      'scheduler.updateJob',
      job.id,
      updateJobInput(job, draft),
    )
    apply(result.scheduler)
    ctx.showToast('定时任务已保存')
  })
}

const JOB_ACTIONS = {
  run: { op: 'scheduler.runJob', toast: '已手动运行任务' },
  pause: { op: 'scheduler.pauseJob', toast: '任务已暂停' },
  resume: { op: 'scheduler.resumeJob', toast: '任务已恢复' },
} as const

function jobAction(job: SchedulerJob, action: keyof typeof JOB_ACTIONS) {
  const { op, toast } = JOB_ACTIONS[action]
  return request(async () => {
    const result = await core(op, job.id)
    apply(result.scheduler)
    ctx.showToast(toast)
  })
}

function removeJob(job: SchedulerJob) {
  if (!canEditSchedulerJob(job)) return
  return request(async () => {
    const result = await core('scheduler.deleteJob', job.id)
    apply(result.scheduler)
    openId.value = ''
    ctx.showToast('定时任务已删除')
  })
}

function setOpen(job: SchedulerJob, open: boolean) {
  openId.value = open ? job.id : openId.value === job.id ? '' : openId.value
}
</script>

<template>
  <SettingsSection
    intro="关闭应用时取消并中断运行；重启只恢复已持久排队的任务，不自动重放未确认完成的运行。启动期间无论错过多少次，最多补跑一次。"
  >
    <div class="summary" data-testid="scheduler-summary">
      <div class="summary-line">
        <StatusBadge
          class="summary-badge"
          :tone="running ? 'ok' : 'neutral'"
          dot
        >
          {{ running ? '服务运行中' : '服务已停止' }}
        </StatusBadge>
        <span
          v-for="item in summary"
          :key="item.text"
          class="summary-item"
          :title="item.title"
        >
          {{ item.text }}
        </span>
      </div>
    </div>
    <p v-if="scheduler.status?.lastError" class="error" role="alert">
      {{ scheduler.status.lastError }}
    </p>

    <SettingsGroup variant="stack">
      <SettingsCard
        v-if="createOpen"
        ref="createCard"
        title="新增定时任务"
        description="创建一个由本地 Scheduler 触发的主 Agent 任务"
        data-create-card
      >
        <SchedulerJobForm
          ref="createForm"
          v-model="createDraft"
          mode="create"
          :disabled="busy"
        />
        <template #footer>
          <Button size="sm" variant="outline" @click="closeCreate">取消</Button>
          <Button
            size="sm"
            variant="primary"
            :disabled="busy || !createDraft.message.trim()"
            data-action="create-job"
            @click="createJob"
          >
            创建任务
          </Button>
        </template>
      </SettingsCard>

      <SchedulerJobCard
        v-for="job in jobs"
        :key="job.id"
        :job="job"
        :busy="busy"
        :open="openId === job.id"
        @update:open="setOpen(job, $event)"
        @set-enabled="jobAction(job, $event ? 'resume' : 'pause')"
        @run="jobAction(job, 'run')"
        @save="saveJob(job, $event)"
        @remove="removeJob(job)"
      />

      <EmptyState
        v-if="!jobs.length && !createOpen"
        title="还没有定时任务"
        description="定时任务会在指定时间把提示词交给主 Agent 执行。"
      >
        <Button size="sm" variant="outline" @click="openCreate">
          <template #icon><DsPlus :size="14" /></template>
          新增任务
        </Button>
      </EmptyState>
    </SettingsGroup>
  </SettingsSection>
</template>

<style scoped>
/* Every item carries a leading 「·」; the line is shifted one separator
   left and clipped, so a wrapped line never starts with a dot. */
.summary {
  min-width: 0;
  padding: var(--space-1) 0;
  overflow: hidden;
}

.summary-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  row-gap: var(--space-1);
  margin-left: calc(var(--space-5) * -1);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
}

.summary-badge {
  margin: 0 var(--space-1) 0 var(--space-5);
}

.summary-item {
  white-space: nowrap;
}

.summary-item::before {
  content: '·';
  display: inline-block;
  width: var(--space-5);
  color: rgb(var(--label-dimmed));
  text-align: center;
}

.error {
  margin: var(--space-2) 0 0;
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}
</style>
