<script setup lang="ts">
/**
 * SchedulerJobDialog — the /scheduler job dialog on ui/Modal.
 * - Create (`job` null): the job form seeded from `draft` (blank or a
 *   「创建」 template); footer 取消 / 创建任务.
 * - Edit (`job` set): status badges + the 启用 switch, the job facts, its
 *   last error, the form (editable jobs; protected system jobs only get a
 *   note), the run history; footer 删除 (inline two-step confirm) /
 *   立即运行 / 保存.
 *
 * Props: job (null = create), draft (create seed), busy (a request is
 * pending). v-model:open. Emits: create(draft), save(draft), run(),
 * set-enabled(enabled), remove().
 */
import { computed, nextTick, ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import {
  DefinitionList,
  EmptyState,
  StatusBadge,
  Switch,
  type DefinitionItem,
} from '../../settings/ui'
import SchedulerJobForm from '../../settings/scheduler/SchedulerJobForm.vue'
import {
  canEditSchedulerJob,
  draftFromJob,
  emptyJobDraft,
  formatMs,
  payloadLabel,
  runDetail,
  runHistory,
  runKey,
  scheduleLabelZh,
  schedulerJobStatus,
  schedulerMisfirePolicyLabel,
  schedulerRunStatusLabel,
  schedulerRunStatusTone,
  type SchedulerJobDraft,
} from '../../settings/scheduler/schedulerModel'
import type { SchedulerJob } from '../../../types'

const props = withDefaults(
  defineProps<{
    job?: SchedulerJob | null
    draft?: SchedulerJobDraft | null
    busy?: boolean
  }>(),
  { job: null, draft: null, busy: false },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  create: [draft: SchedulerJobDraft]
  save: [draft: SchedulerJobDraft]
  run: []
  'set-enabled': [enabled: boolean]
  remove: []
}>()

const form = ref<InstanceType<typeof SchedulerJobForm> | null>(null)
const current = ref<SchedulerJobDraft>(emptyJobDraft())
const confirmDelete = ref(false)

function seed() {
  current.value = props.job
    ? draftFromJob(props.job)
    : { ...(props.draft ?? emptyJobDraft()) }
  confirmDelete.value = false
}

watch(open, async (value) => {
  if (!value) return
  seed()
  if (props.job) return
  await nextTick()
  form.value?.focus()
})

// Another job in the same open dialog: reseed. Core replacing this job
// (run, pause, save) keeps the fields as the person left them.
watch(
  () => props.job?.id,
  (id, previous) => {
    if (open.value && id && id !== previous) seed()
  },
)

const creating = computed(() => !props.job)
const editable = computed(
  () => creating.value || canEditSchedulerJob(props.job),
)
const status = computed(() =>
  props.job ? schedulerJobStatus(props.job) : null,
)
const history = computed(() => runHistory(props.job))
const title = computed(() => props.job?.name ?? '新建定时任务')
const canSubmit = computed(
  () => !props.busy && Boolean(current.value.message.trim()),
)

/** Two columns of facts: what the job is / when it runs. */
const facts = computed<DefinitionItem[][]>(() => {
  const job = props.job
  if (!job) return []
  const what: DefinitionItem[] = [
    { term: 'ID', value: job.id, mono: true },
    { term: '载荷', value: payloadLabel(job) },
    { term: '计划', value: scheduleLabelZh(job) },
    { term: '错过策略', value: schedulerMisfirePolicyLabel(job.misfirePolicy) },
  ]
  if (job.purpose) what.splice(2, 0, { term: '用途', value: job.purpose })
  const when: DefinitionItem[] = [
    { term: '下次运行', value: formatMs(job.state?.nextRunAtMs) },
    {
      term: '上次运行',
      value: job.state?.lastRunAtMs
        ? `${formatMs(job.state.lastRunAtMs)} · ${schedulerRunStatusLabel(job.state?.lastStatus)}`
        : schedulerRunStatusLabel(job.state?.lastStatus),
    },
    { term: '创建', value: formatMs(job.createdAtMs) },
    { term: '运行后', value: job.deleteAfterRun ? '删除任务' : '持续保留' },
  ]
  return [what, when]
})

function submit() {
  if (!canSubmit.value) return
  if (creating.value) emit('create', current.value)
  else if (editable.value) emit('save', current.value)
}
</script>

<template>
  <Modal v-model:open="open" :title="title" :width="600" :close-on-mask="!busy">
    <div
      class="job-dialog"
      data-testid="scheduler-job-dialog"
      :data-mode="creating ? 'create' : 'edit'"
    >
      <div v-if="job && status" class="meta">
        <div class="badges">
          <StatusBadge :tone="status.tone" dot>{{ status.label }}</StatusBadge>
          <StatusBadge v-if="job.protected">受保护</StatusBadge>
          <StatusBadge v-if="job.deleteAfterRun">一次性</StatusBadge>
        </div>
        <span class="toggle">
          <span aria-hidden="true">启用</span>
          <Switch
            :model-value="job.enabled"
            :disabled="busy"
            :aria-label="`启用「${job.name}」`"
            @update:model-value="emit('set-enabled', $event)"
          />
        </span>
      </div>

      <div v-if="facts.length" class="facts">
        <DefinitionList
          v-for="(column, index) in facts"
          :key="index"
          :items="column"
          :label-width="64"
        />
      </div>
      <p v-if="job?.state?.lastError" class="error" role="alert">
        {{ job.state.lastError }}
      </p>

      <SchedulerJobForm
        v-if="editable"
        ref="form"
        v-model="current"
        :mode="creating ? 'create' : 'edit'"
        :disabled="busy"
      />
      <p v-else class="note">
        受保护的系统任务：可以暂停、恢复或立即运行，不能编辑或删除。
      </p>

      <section v-if="job" class="history" :aria-label="`${job.name} 运行历史`">
        <div class="history-head">
          <span class="history-title">运行历史</span>
          <span class="history-count">{{ history.length }} 条</span>
        </div>
        <ul v-if="history.length" class="runs">
          <li v-for="run in history" :key="runKey(run)" class="run">
            <div class="run-top">
              <StatusBadge :tone="schedulerRunStatusTone(run.status)">
                {{ schedulerRunStatusLabel(run.status) }}
              </StatusBadge>
              <span class="run-time">实际 {{ formatMs(run.runAtMs) }}</span>
            </div>
            <p class="run-detail">{{ runDetail(run) }}</p>
            <p v-if="run.error" class="run-error">{{ run.error }}</p>
          </li>
        </ul>
        <EmptyState v-else title="暂无运行记录" variant="plain" compact />
      </section>
    </div>

    <template #footer>
      <template v-if="creating">
        <Button size="sm" variant="outline" @click="open = false">取消</Button>
        <Button
          size="sm"
          variant="primary"
          :disabled="!canSubmit"
          data-action="create-job"
          @click="submit"
        >
          创建任务
        </Button>
      </template>
      <template v-else-if="confirmDelete">
        <span class="confirm">删除定时任务「{{ job?.name }}」？</span>
        <Button size="sm" variant="outline" @click="confirmDelete = false">
          取消
        </Button>
        <Button
          size="sm"
          variant="danger"
          :disabled="busy"
          data-action="confirm-delete"
          @click="emit('remove')"
        >
          确认删除
        </Button>
      </template>
      <template v-else>
        <Button
          v-if="editable"
          class="delete"
          size="sm"
          variant="danger"
          :disabled="busy"
          data-action="delete-job"
          @click="confirmDelete = true"
        >
          删除
        </Button>
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          data-action="run-job"
          @click="emit('run')"
        >
          立即运行
        </Button>
        <Button
          v-if="editable"
          size="sm"
          variant="primary"
          :disabled="!canSubmit"
          data-action="save-job"
          @click="submit"
        >
          保存
        </Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
/* The form's and rows' @container rules resolve against this body. */
.job-dialog {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
  padding-bottom: var(--space-0-5);
}

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-width: 0;
}

.toggle {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1-5) var(--space-4);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
}

.error,
.run-error {
  margin: 0;
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  color: rgb(var(--state-error-label));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}

.note {
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.history {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-l1);
}

.history-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.history-title {
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
}

.history-count {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}

.runs {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.run {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-l1);
}

.run:last-child {
  border-bottom: none;
}

.run-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.run-time,
.run-detail {
  margin: 0;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
}

.run-error {
  padding: var(--space-1) var(--space-2);
}

.confirm {
  flex: 1;
  min-width: 0;
  color: rgb(var(--state-error-label));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.delete {
  margin-right: auto;
}

@container (max-width: 479px) {
  .facts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
