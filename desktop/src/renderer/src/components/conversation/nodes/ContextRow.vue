<script setup lang="ts">
/**
 * ContextRow — dsh ContextInjectionRow: collapsed 24px row
 * `上下文注入 · {producer} · {summary}`; expanded, a 141px-capped mono
 * box with the injected text (or the instruction file list).
 */
import { computed } from 'vue'
import type { ContextChatNode } from '../../../conversation/types'
import { DsBrowse } from '../../icons/ds'
import DisclosureRow from '../../ui/DisclosureRow.vue'
import { useExpansion } from '../chatContext'

const props = defineProps<{ node: ContextChatNode }>()
const open = useExpansion(() => `${props.node.key}:body`)

const PRODUCER_LABEL: Record<string, string> = {
  'runtime-context': '运行时上下文',
  memory: '长期记忆',
  subagent: '委派任务',
  goal: '目标',
  'goal-round': '目标轮次',
  'plan-mode': '计划模式',
  skills: '技能目录',
  relay: '转发消息',
  scheduler: '定时任务',
  compaction: '压缩检查点',
  hook: 'Hook',
}

const title = computed(() =>
  props.node.data.origin === 'instructions' ? '指令文件' : '上下文注入',
)
const source = computed(() => {
  const data = props.node.data
  if (data.origin === 'instructions')
    return data.files.length === 0 ? '无' : `${data.files.length} 个文件`
  return PRODUCER_LABEL[data.producer] ?? data.producer
})
const summary = computed(() => {
  const data = props.node.data
  if (data.origin === 'instructions') return data.files.join('、')
  return data.summary ?? ''
})
const body = computed(() => {
  const data = props.node.data
  return data.origin === 'instructions' ? data.files.join('\n') : data.text
})
</script>

<template>
  <div class="context-row">
    <DisclosureRow v-model:open="open" :title="title" :expandable="body !== ''">
      <template #icon><DsBrowse :size="14" /></template>
      <template #summary>
        <span class="source">{{ source }}</span>
        <template v-if="summary">
          <span class="sep" aria-hidden="true" />
          <span class="text">{{ summary }}</span>
        </template>
      </template>
      <div class="body">{{ body }}</div>
    </DisclosureRow>
  </div>
</template>

<style scoped>
.context-row {
  min-width: 0;
}

.context-row :deep(.summary) {
  display: flex;
  align-items: center;
}

.source {
  flex: none;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 var(--space-2);
  border-radius: 50%;
  background: rgb(var(--label-caption));
}

.text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body {
  box-sizing: border-box;
  max-height: 141px;
  margin-top: var(--space-1);
  padding: var(--space-2-5) var(--space-4) var(--space-3) var(--space-3);
  overflow: auto;
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  color: rgb(var(--label-tertiary));
  font: 400 var(--fs-xxxs) / 16px var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
