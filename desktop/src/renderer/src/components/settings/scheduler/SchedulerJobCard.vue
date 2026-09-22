<script setup lang="ts">
/**
 * SchedulerJobCard — one Scheduler job as an expandable SettingsCard.
 * Header: name + status / 受保护 / 一次性 badges, schedule · next run, and
 * the enable Switch (pause / resume). Body (open): job facts, the last
 * error, the inline edit form (editable jobs only), the run history; the
 * footer holds 删除 (two-step confirm) / 立即运行 / 保存.
 *
 * Props: job, busy (a scheduler request is pending).
 * v-model:open — expanded state (the section keeps one job open).
 * Emits: set-enabled(enabled), run(), save(draft), remove().
 */
import { computed, ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import {
  DefinitionList,
  EmptyState,
  SettingsCard,
  StatusBadge,
  Switch,
  type DefinitionItem,
} from '../ui'
import SchedulerJobForm from './SchedulerJobForm.vue'
import {
  canEditSchedulerJob,
  draftFromJob,
  formatMs,
  formatShortMs,
  payloadLabel,
  runDetail,
  runHistory,
  runKey,
  scheduleLabel,
  schedulerJobStatus,
  schedulerMisfirePolicyLabel,
  schedulerRunStatusLabel,
  schedulerRunStatusTone,
  type SchedulerJobDraft,
} from './schedulerModel'
import type { SchedulerJob } from '../../../types'

const props = withDefaults(
  defineProps<{ job: SchedulerJob; busy?: boolean }>(),
  { busy: false },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  'set-enabled': [enabled: boolean]
  run: []
  save: [draft: SchedulerJobDraft]
  remove: []
}>()

const draft = ref<SchedulerJobDraft>(draftFromJob(props.job))
const confirmDelete = ref(false)

watch(
  () => props.job,
  (job) => {
    draft.value = draftFromJob(job)
  },
)
watch(open, (value) => {
  if (!value) confirmDelete.value = false
})

const status = computed(() => schedulerJobStatus(props.job))
const editable = computed(() => canEditSchedulerJob(props.job))
const history = computed(() => runHistory(props.job))
const description = computed(() => {
  const next = props.job.state?.nextRunAtMs
  const schedule = scheduleLabel(props.job)
  return next ? `${schedule} · 下次 ${formatShortMs(next)}` : schedule
})
/** Two columns of facts: what the job is / when it runs. */
const facts = computed<DefinitionItem[][]>(() => {
  const job = props.job
  const what: DefinitionItem[] = [
    { term: 'ID', value: job.id, mono: true },
    { term: '载荷', value: payloadLabel(job) },
    { term: '错过策略', value: schedulerMisfirePolicyLabel(job.misfirePolicy) },
    { term: '运行后', value: job.deleteAfterRun ? '删除任务' : '持续保留' },
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
    { term: '更新', value: formatMs(job.updatedAtMs) },
  ]
  return [what, when]
})
</script>

<template>
  <SettingsCard
    v-model:open="open"
    expandable
    :title="job.name"
    :description="description"
    :data-job-id="job.id"
  >
    <template #meta>
      <StatusBadge :tone="status.tone" dot>{{ status.label }}</StatusBadge>
      <StatusBadge v-if="job.protected">受保护</StatusBadge>
      <StatusBadge v-if="job.deleteAfterRun">一次性</StatusBadge>
    </template>
    <template #actions>
      <Switch
        :model-value="job.enabled"
        :disabled="busy"
        :aria-label="`启用「${job.name}」`"
        @update:model-value="emit('set-enabled', $event)"
      />
    </template>

    <div class="facts">
      <DefinitionList
        v-for="(column, index) in facts"
        :key="index"
        :items="column"
        :label-width="64"
      />
    </div>
    <p v-if="job.state?.lastError" class="error" role="alert">
      {{ job.state.lastError }}
    </p>
    <SchedulerJobForm v-if="editable" v-model="draft" :disabled="busy" />
    <p v-else class="note">
      受保护的系统任务：可以暂停、恢复或立即运行，不能编辑或删除。
    </p>

    <section class="history" :aria-label="`${job.name} 运行历史`">
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
          <p v-if="run.runId" class="run-meta">
            run {{ run.runId }} · task {{ run.taskId || '-' }}
          </p>
          <p v-if="run.error" class="run-error">{{ run.error }}</p>
        </li>
      </ul>
      <EmptyState v-else title="暂无运行记录" variant="plain" compact />
    </section>

    <template #footer>
      <template v-if="confirmDelete">
        <span class="confirm">删除定时任务「{{ job.name }}」？</span>
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
          @click="confirmDelete = true"
        >
          删除
        </Button>
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          @click="emit('run')"
        >
          立即运行
        </Button>
        <Button
          v-if="editable"
          size="sm"
          variant="primary"
          :disabled="busy || !draft.message.trim()"
          @click="emit('save', draft)"
        >
          保存
        </Button>
      </template>
    </template>
  </SettingsCard>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1-5) var(--space-4);
  min-width: 0;
}

.error,
.run-error {
  margin: 0;
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.note {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.history {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
  padding-top: var(--space-1);
}

.history-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.history-title {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 600;
  color: rgb(var(--label-primary));
}

.history-count {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
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
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  font-variant-numeric: tabular-nums;
}

.run-detail,
.run-meta {
  margin: 0;
}

.run-meta {
  font-family: var(--font-mono);
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.run-error {
  padding: var(--space-1) var(--space-2);
}

.confirm {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-error-label));
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
