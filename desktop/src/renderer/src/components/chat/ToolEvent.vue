<script setup lang="ts">
import { computed } from 'vue'
import type { ToolSegment, ToolStatus } from '../../types'
import { toolIcon } from '../../icons'
import ToolDetailBody from './ToolDetailBody.vue'
import { toolStatusText } from './toolDisplay'

const props = defineProps<{ segment: ToolSegment }>()
const title = computed(() => props.segment.displayName || displayName(props.segment.name))
const purpose = computed(() => toolPurpose(props.segment.name))
const defaultOpen = computed(() =>
  props.segment.status === 'running' ||
  Boolean(props.segment.subagents?.length),
)

function statusLabel(status: ToolStatus) {
  return toolStatusText(status)
}

function displayName(name: string) {
  const names: Record<string, string> = {
    dispatch_subagent: 'Agent',
    edit_file: 'Edit',
    glob: 'Glob',
    grep: 'Search',
    load_skill: 'Skill',
    read_file: 'Read',
    run_command: 'Bash',
    scheduler: 'Scheduler',
    update_todos: 'Update Todos',
    web_fetch: 'Fetch',
    write_file: 'Write',
  }
  return names[name] || name
}

function toolPurpose(name: string) {
  const purposes: Record<string, string> = {
    dispatch_subagent: '派遣子代理执行独立任务',
    edit_file: '修改文件',
    glob: '匹配工作区路径',
    grep: '搜索文本',
    load_skill: '加载 Skill 上下文',
    read_file: '读取文件',
    run_command: '执行命令',
    scheduler: '调度长期任务',
    update_todos: '更新任务规划',
    web_fetch: '读取网页',
    write_file: '写入文件',
  }
  return purposes[name] || '工具执行'
}

function durationLabel(ms?: number) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
</script>

<template>
  <details class="timeline-node activity-card tool-step" :class="props.segment.status" :open="defaultOpen">
    <summary class="activity-summary">
      <span class="activity-rail" aria-hidden="true">
        <component :is="toolIcon(props.segment.name)" class="activity-icon" :size="16" />
        <span class="activity-status-dot" />
      </span>
      <span class="activity-main">
        <span class="activity-kicker">Tool Step</span>
        <strong>{{ title }} <em>{{ props.segment.name }}</em></strong>
        <small>{{ purpose }}</small>
      </span>
      <span class="activity-meta">
        <em>{{ statusLabel(props.segment.status) }}</em>
        <time v-if="durationLabel(props.segment.durationMs)">{{ durationLabel(props.segment.durationMs) }}</time>
      </span>
    </summary>

    <ToolDetailBody :segment="props.segment" />
  </details>
</template>
