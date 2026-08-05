<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import type { ToolSegment, ToolStatus } from '../../types'
import { toolIcon } from '../../icons'
import type { AssistantFlowBlock } from './assistantFlowProjection'
import ToolDetailBody from './ToolDetailBody.vue'
import { CHAT_EXPANSION_STORE_KEY } from './expansionStoreKey'
import {
  durationLabel,
  toolPurpose,
  toolStatusText,
  toolTitle,
} from './toolDisplay'
import { toolCardDefaultOpen, toolGroupDetailText } from './toolGroupModel'

type ToolGroupBlock = Extract<AssistantFlowBlock, { kind: 'tool_group' }>

const props = defineProps<{ block: ToolGroupBlock }>()

const defaultOpen = computed(() => toolCardDefaultOpen(props.block.tools))
const firstFailedToolId = computed(
  () =>
    props.block.tools.find(
      (tool) => tool.status === 'error' || tool.status === 'error_aborted',
    )?.id,
)
const selectedToolId = ref(
  firstFailedToolId.value || props.block.tools[0]?.id || '',
)
watch(
  () => props.block.id,
  () => {
    selectedToolId.value =
      firstFailedToolId.value || props.block.tools[0]?.id || ''
  },
)
watch(firstFailedToolId, (toolId) => {
  if (toolId) selectedToolId.value = toolId
})
const selectedTool = computed(
  () =>
    props.block.tools.find((tool) => tool.id === selectedToolId.value) ||
    props.block.tools[0],
)

// Wave6：展开态存到 MessageList 提供的 store，虚拟滚动卸载重挂不丢
const expansion = inject(CHAT_EXPANSION_STORE_KEY, null)
const isOpen = computed(() =>
  expansion
    ? expansion.isOpen(`tool_group:${props.block.id}`, defaultOpen.value)
    : defaultOpen.value,
)

function onToggle(event: Event) {
  expansion?.setOpen(
    `tool_group:${props.block.id}`,
    (event.target as HTMLDetailsElement).open,
  )
}

const primaryTool = computed(() => props.block.tools[0])
const agentCount = computed(() =>
  props.block.tools.reduce((count, tool) => {
    if (tool.name !== 'dispatch_subagent')
      return count + (tool.subagents?.length || 0)
    return count + Math.max(1, tool.subagents?.length || 0)
  }, 0),
)

const statusText = computed(() => statusLabel(props.block.status))
const detailText = computed(() => toolGroupDetailText(props.block.tools))

function statusLabel(status: ToolStatus) {
  return toolStatusText(status)
}

function toolStatusLabel(tool: ToolSegment) {
  return statusLabel(tool.status)
}

/** 工具行结果小字:名称→目标→结果 的第三级信息(summary 非语义摘要,仅截断展示) */
function toolResultLine(tool: ToolSegment) {
  if (tool.status === 'queued') return '排队中'
  if (tool.status === 'running') return '等待结果…'
  const summary = (tool.summary || '').replace(/\s+/g, ' ').trim()
  if (summary) return summary
  if (tool.status === 'error' || tool.status === 'error_aborted')
    return '工具执行出错'
  return ''
}

function selectTool(tool: ToolSegment) {
  selectedToolId.value = tool.id
}
</script>

<template>
  <details
    class="timeline-node tool-group-card"
    :class="props.block.status"
    :open="isOpen"
    @toggle="onToggle"
  >
    <summary class="tool-group-summary">
      <span class="tool-group-icon" aria-hidden="true">
        <component :is="toolIcon(primaryTool?.name || 'tool')" :size="15" />
        <span class="tool-status-dot" :data-status="props.block.status" />
      </span>
      <span class="tool-group-main">
        <strong>{{ props.block.title }}</strong>
        <small v-if="detailText">{{ detailText }}</small>
      </span>
      <span class="tool-group-meta">
        <em v-if="agentCount">Agent × {{ agentCount }}</em>
        <em>{{ statusText }}</em>
        <time v-if="durationLabel(props.block.durationMs)">{{
          durationLabel(props.block.durationMs)
        }}</time>
      </span>
    </summary>

    <div class="tool-group-body">
      <div class="tool-group-tool-list" role="list">
        <button
          v-for="tool in props.block.tools"
          :key="tool.id"
          type="button"
          class="tool-group-tool-row"
          :class="[tool.status, { selected: selectedTool?.id === tool.id }]"
          role="listitem"
          @click="selectTool(tool)"
        >
          <span class="tool-group-tool-icon" aria-hidden="true">
            <component :is="toolIcon(tool.name)" :size="14" />
            <span class="tool-status-dot" :data-status="tool.status" />
          </span>
          <span class="tool-group-tool-title">
            <strong>{{ toolTitle(tool) }}</strong>
            <small>{{ toolPurpose(tool.name) }}</small>
            <span
              v-if="toolResultLine(tool)"
              class="tool-result-line"
              :class="{ 'dim-blink': tool.status === 'running' }"
              >{{ toolResultLine(tool) }}</span
            >
          </span>
          <span class="tool-group-tool-meta">
            <em>{{ toolStatusLabel(tool) }}</em>
            <time v-if="durationLabel(tool.durationMs)">{{
              durationLabel(tool.durationMs)
            }}</time>
          </span>
        </button>
      </div>
      <ToolDetailBody
        v-if="selectedTool"
        class="tool-group-selected-detail"
        :segment="selectedTool"
      />
    </div>
  </details>
</template>
