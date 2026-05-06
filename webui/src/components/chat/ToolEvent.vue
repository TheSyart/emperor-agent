<script setup lang="ts">
import { computed } from 'vue'
import type { ToolSegment, ToolStatus } from '../../types'
import { compactJson } from '../../utils/format'
import { toolIcon } from '../../assets'
import ExpandableText from './ExpandableText.vue'
import SubagentTrail from './SubagentTrail.vue'

const props = defineProps<{ segment: ToolSegment }>()
const detail = computed(() => props.segment.summary || fullJson(props.segment.arguments) || '等待结果...')

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
</script>

<template>
  <div class="tool-event" :class="props.segment.status">
    <img class="tool-image" :src="toolIcon(props.segment.name)" alt="" width="34" height="34" />
    <div class="min-w-0 flex-1">
      <div class="tool-name">
        <span class="truncate">{{ props.segment.name }}</span>
        <em>{{ statusLabel(props.segment.status) }}</em>
      </div>
      <ExpandableText class="tool-summary" :text="detail" :limit="180" />
      <SubagentTrail
        v-if="props.segment.name === 'dispatch_subagent' && props.segment.subagents?.length"
        :subagents="props.segment.subagents"
      />
    </div>
  </div>
</template>
