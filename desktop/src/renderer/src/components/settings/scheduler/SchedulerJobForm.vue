<script setup lang="ts">
/**
 * SchedulerJobForm — the Scheduler create / edit fields, shown inside a
 * SettingsCard body (the create card or an expanded job card): name, the
 * prompt, schedule kind (Segmented) + its value, the misfire policy and the
 * deliver / delete-after-run switches.
 *
 * Props:
 * - modelValue (v-model): SchedulerJobDraft (replaced, never mutated).
 * - disabled?: read-only fields (protected jobs, pending requests).
 * - mode: 'create' | 'edit' (only changes the misfire hint copy).
 * Exposes: focus() — the name field.
 */
import { computed } from 'vue'
import {
  Field,
  Segmented,
  Select,
  SettingsRow,
  Switch,
  TextArea,
  TextField,
  settingsId,
} from '../ui'
import {
  DEFAULT_JOB_NAME,
  SCHEDULE_KIND_OPTIONS,
  schedulerMisfirePolicyOptions,
  type SchedulerJobDraft,
} from './schedulerModel'

const props = withDefaults(
  defineProps<{ disabled?: boolean; mode?: 'create' | 'edit' }>(),
  { disabled: false, mode: 'edit' },
)

const draft = defineModel<SchedulerJobDraft>({ required: true })

function field<K extends keyof SchedulerJobDraft>(key: K) {
  return computed<SchedulerJobDraft[K]>({
    get: () => draft.value[key],
    set: (value) => {
      draft.value = { ...draft.value, [key]: value }
    },
  })
}

const name = field('name')
const message = field('message')
const deliver = field('deliver')
const deleteAfterRun = field('deleteAfterRun')
const misfirePolicy = field('misfirePolicy')
const scheduleKind = field('scheduleKind')
const atLocal = field('atLocal')
const cronExpr = field('cronExpr')
const cronTz = field('cronTz')
const everyMinutes = computed({
  get: () => String(draft.value.everyMinutes),
  set: (value: string) => {
    const minutes = Number(value)
    draft.value = {
      ...draft.value,
      everyMinutes: Number.isFinite(minutes) ? minutes : 0,
    }
  },
})

const misfireOptions = schedulerMisfirePolicyOptions()
const misfireHint = computed(() =>
  props.mode === 'create'
    ? '最多补跑一次；「只运行最近一次」保留最新计划时间，「补跑最早一次」保留首次错过时间。'
    : '只影响启动恢复；无论错过多少次，单个任务最多进入队列一次。',
)
const kindOptions = computed(() =>
  SCHEDULE_KIND_OPTIONS.map((option) => ({
    ...option,
    disabled: props.disabled,
  })),
)
const deliverId = settingsId('scheduler-deliver')
const deleteId = settingsId('scheduler-delete-after-run')
const nameId = settingsId('scheduler-name')
const atId = settingsId('scheduler-at')

defineExpose({
  focus: () => document.getElementById(nameId)?.focus(),
})
</script>

<template>
  <div class="job-form">
    <Field label="任务名称" :id="nameId">
      <TextField
        v-model="name"
        :placeholder="DEFAULT_JOB_NAME"
        autocomplete="off"
        :disabled="disabled"
      />
    </Field>
    <Field label="任务内容 / 提示词" required>
      <TextArea
        v-model="message"
        :min-rows="3"
        :max-rows="8"
        placeholder="描述要推进的任务"
        :disabled="disabled"
      />
    </Field>

    <div class="schedule">
      <div class="schedule-kind">
        <span class="label">计划类型</span>
        <Segmented
          v-model="scheduleKind"
          :options="kindOptions"
          size="md"
          aria-label="计划类型"
        />
      </div>
      <Field v-if="scheduleKind === 'every'" label="间隔分钟">
        <TextField
          v-model="everyMinutes"
          type="number"
          min="1"
          inputmode="numeric"
          :disabled="disabled"
        />
      </Field>
      <Field v-else-if="scheduleKind === 'at'" :id="atId" label="指定时间">
        <input
          :id="atId"
          v-model="atLocal"
          class="native-input"
          type="datetime-local"
          :disabled="disabled"
        />
      </Field>
      <template v-else>
        <Field label="Cron">
          <TextField
            v-model="cronExpr"
            monospace
            placeholder="0 9 * * *"
            :disabled="disabled"
          />
        </Field>
        <Field label="时区">
          <TextField
            v-model="cronTz"
            placeholder="Asia/Shanghai"
            :disabled="disabled"
          />
        </Field>
      </template>
    </div>

    <Field label="应用关闭期间错过计划时" :hint="misfireHint">
      <div class="select-wrap">
        <Select
          v-model="misfirePolicy"
          :options="misfireOptions"
          size="sm"
          :disabled="disabled"
        />
      </div>
    </Field>

    <div class="switches">
      <SettingsRow
        title="将运行结果显示到当前对话"
        :label-for="deliverId"
        dense
      >
        <Switch :id="deliverId" v-model="deliver" :disabled="disabled" />
      </SettingsRow>
      <SettingsRow title="一次性任务运行后删除" :label-for="deleteId" dense>
        <Switch :id="deleteId" v-model="deleteAfterRun" :disabled="disabled" />
      </SettingsRow>
    </div>
  </div>
</template>

<style scoped>
.job-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3-5);
  min-width: 0;
}

.schedule {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-3);
  align-items: start;
}

.schedule-kind {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1-5);
  min-width: 0;
}

.label {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-primary));
}

.native-input {
  width: 100%;
  min-width: 0;
  height: calc(var(--space-8) + 2px);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  outline: none;
  background: rgb(var(--bg-layer-3));
  box-shadow: none;
  font: inherit;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-primary));
  transition: border-color var(--duration-ds-fast) ease;
}

.native-input:focus {
  border-color: rgb(var(--accent-fill));
}

.native-input:disabled {
  background: transparent;
  color: rgb(var(--label-tertiary));
}

.select-wrap {
  display: flex;
  min-width: 0;
}

.switches {
  display: flex;
  flex-direction: column;
}

@container (max-width: 439px) {
  .schedule {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
