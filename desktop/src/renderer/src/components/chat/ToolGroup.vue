<script setup lang="ts">
import { computed } from 'vue'
import type { ToolSegment, ToolStatus } from '../../types'
import { toolIcon } from '../../icons'
import type { AssistantFlowBlock } from './assistantFlowProjection'
import ToolEvent from './ToolEvent.vue'

type ToolGroupBlock = Extract<AssistantFlowBlock, { kind: 'tool_group' }>

const props = defineProps<{ block: ToolGroupBlock }>()

const defaultOpen = computed(() =>
  props.block.status !== 'done' ||
  props.block.tools.some((tool) => Boolean(tool.todos?.length || tool.subagents?.length)),
)

const primaryTool = computed(() => props.block.tools[0])
const runningTools = computed(() => props.block.tools.filter((tool) => tool.status === 'running'))
const errorTools = computed(() => props.block.tools.filter((tool) => tool.status === 'error' || tool.status === 'error_aborted'))
const completedCount = computed(() => props.block.tools.filter((tool) => tool.status === 'done').length)
const agentCount = computed(() =>
  props.block.tools.reduce((count, tool) => {
    const ownAgent = tool.name === 'dispatch_subagent' ? 1 : 0
    return count + ownAgent + (tool.subagents?.length || 0)
  }, 0),
)

const statusText = computed(() => statusLabel(props.block.status))
const detailText = computed(() => {
  if (runningTools.value.length) return `正在执行 ${toolNames(runningTools.value)}`
  if (errorTools.value.length) return `${errorTools.value.length} 个工具需要处理`
  return `已完成 ${completedCount.value}/${props.block.tools.length} 个工具`
})

function toolNames(tools: ToolSegment[]) {
  return tools
    .map((tool) => tool.displayName || tool.name)
    .slice(0, 2)
    .join('、')
}

function statusLabel(status: ToolStatus) {
  if (status === 'done') return '完成'
  if (status === 'running') return '执行中'
  if (status === 'error_aborted') return '已中断'
  return '出错'
}

function durationLabel(ms?: number) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
</script>

<template>
  <details class="timeline-node tool-group-card" :class="props.block.status" :open="defaultOpen">
    <summary class="tool-group-summary">
      <span class="tool-group-icon" aria-hidden="true">
        <component :is="toolIcon(primaryTool?.name || 'tool')" :size="15" />
      </span>
      <span class="tool-group-main">
        <strong>{{ props.block.title }}</strong>
        <small>{{ detailText }}</small>
      </span>
      <span class="tool-group-meta">
        <em v-if="agentCount">Agent × {{ agentCount }}</em>
        <em>{{ statusText }}</em>
        <time v-if="durationLabel(props.block.durationMs)">{{ durationLabel(props.block.durationMs) }}</time>
      </span>
    </summary>

    <div class="tool-group-body">
      <ToolEvent
        v-for="tool in props.block.tools"
        :key="tool.id"
        :segment="tool"
      />
    </div>
  </details>
</template>
