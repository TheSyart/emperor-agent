<script setup lang="ts">
/**
 * BashView — terminal card for a shell call: command banner, output with
 * the kernel exit markers stripped, exit-code pill; a background call adds
 * its job line. Execution failures without terminal material fall back to
 * the IN/OUT card.
 */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import InOutCard from '../../ui/InOutCard.vue'
import StateDot from '../../ui/StateDot.vue'
import TerminalBlock from '../../ui/TerminalBlock.vue'
import {
  JOB_STATUS_LABEL,
  argsOf,
  resultText,
  shellOutcome,
  stringArg,
} from './toolModel'

const props = defineProps<{ data: ToolChatData }>()

const args = computed(() => argsOf(props.data))
const command = computed(() => stringArg(args.value, 'command') ?? '')
const shell = computed(() => shellOutcome(props.data))
const failedWithoutOutput = computed(
  () =>
    props.data.result?.isError === true && props.data.result.meta === undefined,
)
const job = computed(() => props.data.job)
const jobDot = computed(() => {
  switch (job.value?.status) {
    case 'running':
      return 'ongoing' as const
    case 'completed':
      return job.value.exitCode !== undefined && job.value.exitCode !== 0
        ? ('error' as const)
        : ('ok' as const)
    case 'failed':
      return 'error' as const
    default:
      return 'warn' as const
  }
})
</script>

<template>
  <div class="bash-view">
    <InOutCard
      v-if="failedWithoutOutput"
      :input="command"
      :output="resultText(data)"
      error
    />
    <TerminalBlock
      v-else-if="!shell.background"
      :command="command"
      :cwd="stringArg(args, 'workdir')"
      :output="shell.output"
      :exit-code="shell.exitCode"
      :signal="shell.signal"
      :running="data.status === 'running'"
      :max-lines="40"
    />
    <template v-else>
      <TerminalBlock
        :command="command"
        :cwd="stringArg(args, 'workdir')"
        :running="job?.status === 'running'"
        :exit-code="job?.exitCode"
      />
      <div class="job-line">
        <StateDot :state="jobDot" />
        <span class="job-title">后台任务</span>
        <code class="job-id">{{ shell.jobId ?? job?.jobId }}</code>
        <span class="job-status">{{
          job === undefined
            ? '已启动'
            : (JOB_STATUS_LABEL[job.status] ?? job.status)
        }}</span>
        <span v-if="job?.exitCode !== undefined" class="job-detail"
          >退出码 {{ job.exitCode }}</span
        >
        <span v-if="job?.detail" class="job-detail">{{ job.detail }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bash-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.job-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding-left: var(--space-1);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.job-title {
  flex: none;
}

.job-id {
  flex: none;
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
}

.job-status {
  flex: none;
}

.job-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--label-tertiary));
}
</style>
