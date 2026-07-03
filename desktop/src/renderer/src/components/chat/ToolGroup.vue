<script setup lang="ts">
import { computed, inject } from 'vue'
import type { ToolSegment, ToolStatus } from '../../types'
import { toolIcon } from '../../icons'
import type { AssistantFlowBlock } from './assistantFlowProjection'
import ToolDetailBody from './ToolDetailBody.vue'
import { CHAT_EXPANSION_STORE_KEY } from './expansionStoreKey'
import { toolPurpose, toolStatusText, toolTitle } from './toolDisplay'
import { toolGroupDetailText } from './toolGroupModel'

type ToolGroupBlock = Extract<AssistantFlowBlock, { kind: 'tool_group' }>

const props = defineProps<{ block: ToolGroupBlock }>()

const defaultOpen = computed(() =>
  props.block.status !== 'done' ||
  props.block.tools.some((tool) => Boolean(tool.subagents?.length)),
)

// Wave6：展开态存到 MessageList 提供的 store，虚拟滚动卸载重挂不丢
const expansion = inject(CHAT_EXPANSION_STORE_KEY, null)
const isOpen = computed(() => expansion ? expansion.isOpen(`tool_group:${props.block.id}`, defaultOpen.value) : defaultOpen.value)

function onToggle(event: Event) {
  expansion?.setOpen(`tool_group:${props.block.id}`, (event.target as HTMLDetailsElement).open)
}

const primaryTool = computed(() => props.block.tools[0])
const agentCount = computed(() =>
  props.block.tools.reduce((count, tool) => {
    const ownAgent = tool.name === 'dispatch_subagent' ? 1 : 0
    return count + ownAgent + (tool.subagents?.length || 0)
  }, 0),
)

const statusText = computed(() => statusLabel(props.block.status))
const singleTool = computed(() => props.block.tools.length === 1)
const detailText = computed(() => toolGroupDetailText(props.block.tools))

function statusLabel(status: ToolStatus) {
  return toolStatusText(status)
}

function toolStatusLabel(tool: ToolSegment) {
  return statusLabel(tool.status)
}

function durationLabel(ms?: number) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function isTodoTool(tool: ToolSegment) {
  return tool.name === 'update_todos' && Boolean(tool.todos?.length)
}

</script>

<template>
  <details class="timeline-node tool-group-card" :class="props.block.status" :open="isOpen" @toggle="onToggle">
    <summary class="tool-group-summary">
      <span class="tool-group-icon" aria-hidden="true">
        <component :is="toolIcon(primaryTool?.name || 'tool')" :size="15" />
      </span>
      <span class="tool-group-main">
        <strong>{{ props.block.title }}</strong>
        <small v-if="detailText">{{ detailText }}</small>
      </span>
      <span class="tool-group-meta">
        <em v-if="agentCount">Agent × {{ agentCount }}</em>
        <em>{{ statusText }}</em>
        <time v-if="durationLabel(props.block.durationMs)">{{ durationLabel(props.block.durationMs) }}</time>
      </span>
    </summary>

    <div class="tool-group-body">
      <template v-for="tool in props.block.tools" :key="tool.id">
        <details v-if="isTodoTool(tool)" class="tool-raw-details">
          <summary>查看原始工具详情</summary>
          <ToolDetailBody :segment="tool" />
        </details>
        <ToolDetailBody
          v-else-if="singleTool"
          :segment="tool"
        />
        <section
          v-else
          class="tool-group-tool-row"
          :class="tool.status"
        >
          <header class="tool-group-tool-head">
            <span class="tool-group-tool-icon" aria-hidden="true">
              <component :is="toolIcon(tool.name)" :size="14" />
            </span>
            <span class="tool-group-tool-title">
              <strong>{{ toolTitle(tool) }}</strong>
              <small>{{ toolPurpose(tool.name) }}</small>
            </span>
            <span class="tool-group-tool-meta">
              <em>{{ toolStatusLabel(tool) }}</em>
              <time v-if="durationLabel(tool.durationMs)">{{ durationLabel(tool.durationMs) }}</time>
            </span>
          </header>
          <ToolDetailBody :segment="tool" />
        </section>
      </template>
    </div>
  </details>
</template>
