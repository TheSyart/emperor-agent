<script setup lang="ts">
/**
 * Diagnostics › 环境工具 card body: the read-only environment probe (tools
 * per category: 基础工具 / 当前项目 / Skill 依赖 / 大型依赖), one compact row
 * per tool (id + version on the first line, why it is needed on the second,
 * a right-aligned status badge), plus the legacy install-job history when
 * Core still reports any. Data comes from DiagnosticsSection
 * (environment.getStatus); re-detection is the section header refresh.
 */
import { computed } from 'vue'
import { DsWarning } from '../../icons/ds'
import { EmptyState, SettingsRow, StatusBadge } from '../ui'
import {
  environmentJobStatusLabel,
  environmentJobTone,
  environmentToolSections,
  environmentToolStatusLabel,
  environmentToolTone,
  type EnvironmentStatusPayload,
  type EnvironmentTone,
} from './environmentModel'

const props = defineProps<{
  status: EnvironmentStatusPayload | null
  loading: boolean
  error: string
}>()

const sections = computed(() => environmentToolSections(props.status))
const jobs = computed(() => props.status?.recentJobs ?? [])

function badgeTone(tone: EnvironmentTone) {
  if (tone === 'running') return 'accent' as const
  if (tone === 'muted') return 'neutral' as const
  return tone
}
</script>

<template>
  <div class="env-tools" data-testid="environment-section">
    <div v-if="error" class="env-alert" role="alert">
      <DsWarning :size="16" class="alert-glyph" />
      <span>{{ error }}</span>
    </div>

    <EmptyState
      v-if="loading && !status"
      title="正在检测开发环境…"
      variant="plain"
      compact
    />
    <EmptyState
      v-else-if="!error && !sections.length"
      class="env-empty"
      title="没有需要检测的工具"
      compact
    />

    <template v-for="section in sections" :key="section.id">
      <div class="subhead">
        <span>{{ section.title }}</span>
        <span class="subhead-count">{{ section.tools.length }} 项</span>
      </div>
      <SettingsRow
        v-for="tool in section.tools"
        :key="tool.id"
        dense
        :data-testid="`environment-tool-${tool.id}`"
      >
        <template #title>
          <code class="tool-id">{{ tool.id }}</code>
          <span
            v-if="tool.versionSummary || tool.requiredVersion"
            class="version"
          >
            {{ tool.versionSummary || '未检测到版本' }}
            <template v-if="tool.requiredVersion">
              · 要求 {{ tool.requiredVersion }}
            </template>
          </span>
        </template>
        <template #description>
          <span class="reason" :title="tool.reason">{{ tool.reason }}</span>
        </template>
        <StatusBadge :tone="badgeTone(environmentToolTone(tool.status))" dot>
          {{ environmentToolStatusLabel(tool.status) }}
        </StatusBadge>
      </SettingsRow>
    </template>

    <template v-if="jobs.length">
      <div class="subhead">
        <span>历史安装任务</span>
        <span class="subhead-count">只读兼容记录</span>
      </div>
      <SettingsRow v-for="job in jobs" :key="job.jobId" dense>
        <template #title>
          <code class="tool-id">{{ job.jobId }}</code>
        </template>
        <StatusBadge :tone="badgeTone(environmentJobTone(job.status))" dot>
          {{ environmentJobStatusLabel(job.status) }}
        </StatusBadge>
      </SettingsRow>
    </template>
  </div>
</template>

<style scoped>
.env-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--state-error-soft));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

.alert-glyph {
  flex: none;
  margin-top: var(--space-0-5);
}

.env-tools {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.env-empty {
  margin-top: var(--space-3);
}

/* Category caption between row runs (12/18 tertiary, count right). */
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

.subhead-count {
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.tool-id {
  font: var(--font-code-small);
  font-size: var(--fs-xs);
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.subhead:first-of-type {
  padding-top: 0;
}

.version {
  margin-left: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.reason {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
