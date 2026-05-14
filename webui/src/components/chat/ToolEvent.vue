<script setup lang="ts">
import { computed } from 'vue'
import type { ToolSegment, ToolStatus } from '../../types'
import { compactJson } from '../../utils/format'
import { toolIcon } from '../../assets'
import ExpandableText from './ExpandableText.vue'
import SubagentTrail from './SubagentTrail.vue'

const props = defineProps<{ segment: ToolSegment }>()
const detail = computed(() => props.segment.summary || fullJson(props.segment.arguments) || '等待结果...')
const hasBody = computed(() => Boolean(detail.value || props.segment.subagents?.length))

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

function durationLabel(ms?: number) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
</script>

<template>
  <details class="activity-card" :class="props.segment.status" :open="props.segment.status === 'running' || Boolean(props.segment.subagents?.length)">
    <summary class="activity-summary">
      <span class="activity-rail" aria-hidden="true">
        <img class="activity-icon" :src="toolIcon(props.segment.name)" alt="" width="34" height="34" />
        <span class="activity-status-dot" />
      </span>
      <span class="activity-main">
        <span class="activity-kicker">工具调用</span>
        <strong>{{ props.segment.name }}</strong>
        <small>{{ props.segment.status === 'running' ? '正在等待工具结果' : (props.segment.summary || '已记录执行结果') }}</small>
      </span>
      <span class="activity-meta">
        <em>{{ statusLabel(props.segment.status) }}</em>
        <time v-if="durationLabel(props.segment.durationMs)">{{ durationLabel(props.segment.durationMs) }}</time>
      </span>
    </summary>

    <div v-if="hasBody" class="activity-body">
      <div class="activity-detail">
        <span>{{ props.segment.summary ? '结果摘要' : '调用参数' }}</span>
        <ExpandableText class="tool-summary" :text="detail" :limit="220" />
      </div>
      <SubagentTrail
        v-if="props.segment.subagents?.length"
        :subagents="props.segment.subagents"
      />
    </div>
  </details>
</template>
