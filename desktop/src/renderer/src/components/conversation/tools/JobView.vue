<script setup lang="ts">
/** JobView — job_output / job_kill / job_list: job facts + output text. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import Pill from '../../ui/Pill.vue'
import StateDot from '../../ui/StateDot.vue'
import { stateFromStatus } from '../../ui/stateDot'
import { JOB_STATUS_LABEL, metaOf, resultText } from './toolModel'

interface JobFacts {
  id?: string
  kind?: string
  label?: string
  status?: string
  exitCode?: number
}

const props = defineProps<{ data: ToolChatData }>()
const meta = computed(() => metaOf(props.data))
const jobs = computed<JobFacts[]>(() => {
  const value = meta.value
  if (Array.isArray(value?.jobs)) return value.jobs as JobFacts[]
  if (typeof value?.job === 'object' && value.job !== null)
    return [value.job as JobFacts]
  return []
})
const output = computed(() =>
  resultText(props.data).replace(/\n?\[status: [^\]]*\]\s*$/u, ''),
)
function dot(status: string | undefined) {
  return status === 'completed' ? 'ok' : stateFromStatus(status)
}
</script>

<template>
  <div class="job-view">
    <div v-for="(job, index) in jobs" :key="job.id ?? index" class="job">
      <StateDot :state="dot(job.status)" />
      <code class="id">{{ job.id }}</code>
      <Pill v-if="job.kind">{{ job.kind }}</Pill>
      <span class="label">{{ job.label }}</span>
      <span class="status">{{
        JOB_STATUS_LABEL[job.status ?? ''] ?? job.status
      }}</span>
      <span v-if="job.exitCode !== undefined" class="status"
        >退出码 {{ job.exitCode }}</span
      >
    </div>
    <pre
      v-if="data.name === 'job_output' && output"
      class="output"
      :data-error="data.result?.isError || undefined"
      >{{ output }}</pre>
  </div>
</template>

<style scoped>
.job-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.job {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.id {
  flex: none;
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.output {
  max-height: 240px;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  overflow: auto;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
  font: var(--font-code-small);
  color: rgb(var(--label-secondary));
  white-space: pre-wrap;
  word-break: break-word;
}

.output[data-error] {
  color: rgb(var(--danger));
}
</style>
