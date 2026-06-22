<script setup lang="ts">
import { computed } from 'vue'
import type { ToolSegment, ToolStatus } from '../../types'
import { compactJson } from '../../utils/format'
import { toolIcon } from '../../icons'
import ExpandableText from './ExpandableText.vue'
import SubagentTrail from './SubagentTrail.vue'

const props = defineProps<{ segment: ToolSegment }>()
const inputText = computed(() => fullJson(props.segment.arguments))
const outputText = computed(() => props.segment.summary || (props.segment.status === 'running' ? '等待结果...' : '已记录执行结果'))
const hasInput = computed(() => Boolean(inputText.value))
const hasOutput = computed(() => Boolean(outputText.value))
const hasBody = computed(() => Boolean(hasInput.value || hasOutput.value || props.segment.subagents?.length || props.segment.todos?.length))
const title = computed(() => props.segment.displayName || displayName(props.segment.name))
const purpose = computed(() => toolPurpose(props.segment.name))
const defaultOpen = computed(() =>
  props.segment.status === 'running' ||
  Boolean(props.segment.subagents?.length) ||
  Boolean(props.segment.todos?.length),
)

function statusLabel(status: ToolStatus) {
  if (status === 'done') return '完成'
  if (status === 'error') return '出错'
  if (status === 'error_aborted') return '已中断'
  return '执行中'
}

function fullJson(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return compactJson(value)
  }
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

function todoMarker(status: string) {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '●'
  return '□'
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

    <div v-if="hasBody" class="activity-body">
      <div class="tool-io-grid">
        <div v-if="hasInput" class="tool-io-panel">
          <span>{{ props.segment.inputLabel || 'IN' }}</span>
          <ExpandableText class="tool-summary tool-code" :text="inputText" :limit="360" />
        </div>
        <div v-if="hasOutput" class="tool-io-panel">
          <span>{{ props.segment.outputLabel || 'OUT' }}</span>
          <ExpandableText class="tool-summary" :text="outputText" :limit="360" />
        </div>
      </div>

      <div v-if="props.segment.todos?.length" class="tool-todo-list">
        <div class="tool-todo-head">
          <strong>Update Todos</strong>
          <span>{{ props.segment.todos.length }} 项</span>
        </div>
        <div class="tool-todo-items">
          <div v-for="todo in props.segment.todos" :key="todo.id" class="tool-todo-item" :class="todo.status">
            <span>{{ todoMarker(todo.status) }}</span>
            <em>{{ todo.id }}</em>
            <p>{{ todo.content }}</p>
          </div>
        </div>
      </div>

      <SubagentTrail
        v-if="props.segment.subagents?.length"
        :subagents="props.segment.subagents"
      />
    </div>
  </details>
</template>
