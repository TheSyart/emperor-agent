<script setup lang="ts">
/**
 * SchedulerPage — the /scheduler full page (定时任务). PageShell with the
 * header actions refresh + 「创建 ▾」 (新建任务 or a prefilled template), a
 * search field, the 全部 / 已开启 / 已暂停 / 已完成 tabs and one
 * SchedulerJobRow per job. A row opens SchedulerJobDialog (edit); its ⋯
 * menu runs / pauses / resumes / deletes (delete asks first; protected
 * system jobs cannot be deleted). The service line (running, concurrency,
 * queue) and the shutdown / misfire policy sit under the list.
 *
 * Data: `boot.scheduler`, reloaded with `scheduler.get` on mount and every
 * time the kept-alive page is shown again; runtime `scheduler_*` events keep
 * it current meanwhile. Every mutation replaces it with Core's payload.
 */
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from 'vue'
import { core } from '../../../api/http'
import { useAppContext } from '../../../composables/useAppContext'
import Button from '../../ui/Button.vue'
import Menu from '../../ui/Menu.vue'
import MenuItem from '../../ui/MenuItem.vue'
import Modal from '../../ui/Modal.vue'
import Tabs from '../../ui/Tabs.vue'
import { DsClock, DsPlus, DsSparkle } from '../../icons/ds'
import {
  EmptyState,
  SearchField,
  StatusBadge,
  refreshAction,
  type SettingsHeaderAction,
} from '../../settings/ui'
import {
  canEditSchedulerJob,
  createJobInput,
  emptyJobDraft,
  emptySchedulerPayload,
  filterSchedulerJobs,
  schedulerJobBucket,
  schedulerSummary,
  schedulerTemplateDraft,
  SCHEDULER_FILTERS,
  SCHEDULER_TEMPLATES,
  normalizeSchedulerFilter,
  updateJobInput,
  type SchedulerFilter,
  type SchedulerJobDraft,
} from '../../settings/scheduler/schedulerModel'
import type { SchedulerJob, SchedulerPayload } from '../../../types'
import PageShell from '../PageShell.vue'
import { onPageReactivated } from '../pageLifecycle'
import SchedulerJobDialog from './SchedulerJobDialog.vue'
import SchedulerJobRow from './SchedulerJobRow.vue'

const POLICY_NOTE =
  '关闭应用时取消并中断运行；重启只恢复已持久排队的任务，不自动重放未确认完成的运行。启动期间无论错过多少次，最多补跑一次。'
/** The relative 「下次运行 …」 copy re-reads the clock this often. */
const CLOCK_TICK_MS = 30_000

const ctx = useAppContext()
const busy = ref(false)
const query = ref('')
const filter = ref<SchedulerFilter>('all')
const now = ref(Date.now())

const dialogOpen = ref(false)
const dialogJobId = ref<string | null>(null)
const createDraft = ref<SchedulerJobDraft | null>(null)

const menuJobId = ref<string | null>(null)
const menuAnchor = ref<HTMLElement | null>(null)
const pendingDelete = ref<SchedulerJob | null>(null)

const scheduler = computed<SchedulerPayload>(
  () => ctx.boot.value?.scheduler || emptySchedulerPayload(),
)
const jobs = computed(() => scheduler.value.jobs || [])
const visible = computed(() =>
  filterSchedulerJobs(jobs.value, { query: query.value, filter: filter.value }),
)
const counts = computed(() => {
  const result: Record<SchedulerFilter, number> = {
    all: jobs.value.length,
    enabled: 0,
    paused: 0,
    completed: 0,
  }
  for (const job of jobs.value) result[schedulerJobBucket(job)] += 1
  return result
})
const tabs = computed(() =>
  SCHEDULER_FILTERS.map((item) => ({
    id: item.id,
    label: counts.value[item.id]
      ? `${item.label} ${counts.value[item.id]}`
      : item.label,
  })),
)
const summary = computed(() => schedulerSummary(scheduler.value))
const running = computed(() => Boolean(scheduler.value.status?.running))

const dialogJob = computed(
  () => jobs.value.find((job) => job.id === dialogJobId.value) ?? null,
)
const menuJob = computed(
  () => jobs.value.find((job) => job.id === menuJobId.value) ?? null,
)
const menuOpen = computed({
  get: () => menuJob.value !== null,
  set: (value: boolean) => {
    if (!value) menuJobId.value = null
  },
})
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (value: boolean) => {
    if (!value) pendingDelete.value = null
  },
})

// A job removed elsewhere (runtime event, deleteAfterRun) closes its dialog.
watch(dialogJob, (job) => {
  if (dialogOpen.value && dialogJobId.value && !job) dialogOpen.value = false
})

const headerActions: SettingsHeaderAction[] = [
  refreshAction(() => refresh(), { title: '刷新定时任务' }),
  {
    id: 'create',
    label: '创建',
    kind: 'primary',
    icon: DsPlus,
    menu: [
      {
        id: 'blank',
        label: '新建任务',
        description: '从空白开始设置提示词和计划',
        icon: DsPlus,
        onSelect: () => openCreate(),
      },
      ...SCHEDULER_TEMPLATES.map((template) => ({
        id: template.id,
        label: template.label,
        description: template.description,
        icon: DsSparkle,
        onSelect: () => openCreate(schedulerTemplateDraft(template.id)),
      })),
    ],
  },
]

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
  now.value = Date.now()
  return request(async () => {
    apply(await core('scheduler.get'))
  })
}

let clock: ReturnType<typeof setInterval> | undefined

function startClock() {
  stopClock()
  now.value = Date.now()
  clock = setInterval(() => (now.value = Date.now()), CLOCK_TICK_MS)
}

function stopClock() {
  if (clock !== undefined) clearInterval(clock)
  clock = undefined
}

onMounted(() => {
  startClock()
  void refresh()
})
onPageReactivated(() => refresh())
onActivated(startClock)
onDeactivated(stopClock)
onBeforeUnmount(stopClock)

function selectFilter(value: string) {
  filter.value = normalizeSchedulerFilter(value)
}

function openCreate(draft: SchedulerJobDraft = emptyJobDraft()) {
  dialogJobId.value = null
  createDraft.value = draft
  dialogOpen.value = true
}

function openJob(job: SchedulerJob) {
  createDraft.value = null
  dialogJobId.value = job.id
  dialogOpen.value = true
}

function openMenu(job: SchedulerJob, anchor: HTMLElement) {
  if (menuJobId.value === job.id) {
    menuJobId.value = null
    return
  }
  menuAnchor.value = anchor
  menuJobId.value = job.id
}

function createJob(draft: SchedulerJobDraft) {
  if (!draft.message.trim()) return
  return request(async () => {
    const result = await core('scheduler.createJob', createJobInput(draft))
    apply(result.scheduler)
    dialogOpen.value = false
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
    dialogOpen.value = false
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

function askDelete(job: SchedulerJob) {
  if (canEditSchedulerJob(job)) pendingDelete.value = job
}

function removeJob(job: SchedulerJob) {
  if (!canEditSchedulerJob(job)) return
  return request(async () => {
    const result = await core('scheduler.deleteJob', job.id)
    apply(result.scheduler)
    if (dialogJobId.value === job.id) dialogOpen.value = false
    pendingDelete.value = null
    ctx.showToast('定时任务已删除')
  })
}

function clearSearch() {
  query.value = ''
  filter.value = 'all'
}
</script>

<template>
  <PageShell
    title="定时任务"
    subtitle="让 Emperor 按计划执行任务、定期检查进展或提醒你"
    :actions="headerActions"
  >
    <div class="scheduler-page">
      <SearchField
        v-model="query"
        class="search"
        placeholder="搜索已安排任务"
        aria-label="搜索已安排任务"
      />
      <Tabs
        class="filters"
        :model-value="filter"
        :tabs="tabs"
        aria-label="按状态筛选"
        @update:model-value="selectFilter"
      />

      <p v-if="scheduler.status?.lastError" class="error" role="alert">
        {{ scheduler.status.lastError }}
      </p>

      <ul v-if="visible.length" class="rows" aria-label="定时任务">
        <SchedulerJobRow
          v-for="job in visible"
          :key="job.id"
          :job="job"
          :now="now"
          :menu-open="menuJobId === job.id"
          @open="openJob(job)"
          @menu="openMenu(job, $event)"
        />
      </ul>
      <EmptyState
        v-else-if="!jobs.length"
        :icon="DsClock"
        title="还没有定时任务"
        description="定时任务会在指定时间把提示词交给主 Agent 执行，比如每天汇总进展或每周整理周报。"
      >
        <Button size="sm" variant="outline" @click="openCreate()">
          <template #icon><DsPlus :size="14" /></template>
          新建任务
        </Button>
      </EmptyState>
      <EmptyState
        v-else
        compact
        title="没有匹配的任务"
        description="换个关键词或状态试试。"
      >
        <Button size="sm" variant="outline" @click="clearSearch">
          清除筛选
        </Button>
      </EmptyState>

      <footer class="service">
        <div class="summary-line" data-testid="scheduler-summary">
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
        <p class="policy">{{ POLICY_NOTE }}</p>
      </footer>
    </div>

    <Menu
      v-model:open="menuOpen"
      :anchor="menuAnchor"
      :label="menuJob ? `「${menuJob.name}」的操作` : undefined"
      :width="180"
      placement="bottom"
    >
      <template v-if="menuJob">
        <MenuItem
          data-menu-item="run"
          :disabled="busy"
          @select="jobAction(menuJob, 'run')"
        >
          立即运行
        </MenuItem>
        <MenuItem
          v-if="menuJob.enabled"
          data-menu-item="pause"
          :disabled="busy"
          @select="jobAction(menuJob, 'pause')"
        >
          暂停
        </MenuItem>
        <MenuItem
          v-else
          data-menu-item="resume"
          :disabled="busy"
          @select="jobAction(menuJob, 'resume')"
        >
          恢复
        </MenuItem>
        <MenuItem variant="separator" />
        <MenuItem
          data-menu-item="delete"
          danger
          :disabled="busy || !canEditSchedulerJob(menuJob)"
          :description="
            canEditSchedulerJob(menuJob) ? undefined : '受保护的系统任务'
          "
          @select="askDelete(menuJob)"
        >
          删除
        </MenuItem>
      </template>
    </Menu>

    <SchedulerJobDialog
      v-model:open="dialogOpen"
      :job="dialogJob"
      :draft="createDraft"
      :busy="busy"
      @create="createJob"
      @save="dialogJob && saveJob(dialogJob, $event)"
      @run="dialogJob && jobAction(dialogJob, 'run')"
      @set-enabled="
        dialogJob && jobAction(dialogJob, $event ? 'resume' : 'pause')
      "
      @remove="dialogJob && removeJob(dialogJob)"
    />

    <Modal
      v-model:open="deleteOpen"
      :title="`删除「${pendingDelete?.name ?? ''}」？`"
      description="任务和它的运行历史都会删除，无法撤销。"
    >
      <template #footer>
        <Button variant="outline" @click="pendingDelete = null">取消</Button>
        <Button
          variant="danger"
          data-action="confirm-delete"
          :disabled="busy"
          @click="pendingDelete && removeJob(pendingDelete)"
        >
          删除
        </Button>
      </template>
    </Modal>
  </PageShell>
</template>

<style scoped>
.scheduler-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.filters {
  border-bottom: 1px solid var(--border-l2);
}

.error {
  margin: 0;
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  color: rgb(var(--state-error-label));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.service {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-l1);
  overflow: hidden;
}

/* Every item carries a leading 「·」; the line is shifted one separator
   left and clipped, so a wrapped line never starts with a dot. */
.summary-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  row-gap: var(--space-1);
  margin-left: calc(var(--space-5) * -1);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
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

.policy {
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-wrap: pretty;
}
</style>
