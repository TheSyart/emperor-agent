<script setup lang="ts">
/**
 * Diagnostics › 环境工具 card body: the read-only environment probe (tools
 * per category: 基础工具 / 当前项目 / Skill 依赖 / 大型依赖), one row per
 * tool read like the other cards' rows (DiagnosticItem): the detected
 * version of a ready tool, or its state and why. Plus the legacy
 * install-job history when Core still reports any. Data comes from
 * DiagnosticsSection (environment.getStatus), whose notice reports a failed
 * probe; re-detection is the section header refresh.
 */
import { computed } from 'vue'
import { EmptyState } from '../ui'
import DiagnosticItem from './DiagnosticItem.vue'
import {
  environmentJobStatusLabel,
  environmentJobTone,
  environmentToolRow,
  environmentToolSections,
  type EnvironmentStatusPayload,
} from './environmentModel'

const props = defineProps<{
  status: EnvironmentStatusPayload | null
  loading: boolean
  error: string
}>()

const sections = computed(() => environmentToolSections(props.status))
const jobs = computed(() => props.status?.recentJobs ?? [])
</script>

<template>
  <div class="env-tools" data-testid="environment-section">
    <EmptyState
      v-if="loading && !status"
      title="正在检测开发环境…"
      variant="plain"
      compact
    />
    <EmptyState
      v-else-if="!sections.length"
      :title="error ? '没有检测结果' : '没有需要检测的工具'"
      variant="plain"
      compact
    />

    <template v-for="section in sections" :key="section.id">
      <div class="subhead">
        <span>{{ section.title }}</span>
        <span class="subhead-count">{{ section.tools.length }} 项</span>
      </div>
      <DiagnosticItem
        v-for="tool in section.tools"
        :key="tool.id"
        :row="environmentToolRow(tool)"
        :data-testid="`environment-tool-${tool.id}`"
      />
    </template>

    <template v-if="jobs.length">
      <div class="subhead">
        <span>历史安装任务</span>
        <span class="subhead-count">只读兼容记录</span>
      </div>
      <DiagnosticItem
        v-for="job in jobs"
        :key="job.jobId"
        :row="{
          label: job.jobId,
          value: environmentJobStatusLabel(job.status),
          detail: '',
          tone: environmentJobTone(job.status),
        }"
      />
    </template>
  </div>
</template>

<style scoped>
.env-tools {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* Category caption between row runs (12/18 secondary, count right). */
.subhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) 0 var(--space-0-5);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-secondary));
}

.subhead:first-child {
  padding-top: 0;
}

.subhead-count {
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}
</style>
