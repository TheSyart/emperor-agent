<script setup lang="ts">
import type { SubagentState, ToolStatus } from '../../types'
import { compactJson } from '../../utils/format'
import { avatarAssets, toolIcon } from '../../assets'
import ExpandableText from './ExpandableText.vue'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ subagents: SubagentState[] }>()

function statusLabel(status?: ToolStatus) {
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
  <div class="mt-3 space-y-2 border-l border-amber/30 pl-3">
    <details v-for="sub in props.subagents" :key="sub.id || sub.agent_type" class="subagent-card" open>
      <summary class="flex cursor-pointer items-center gap-2 text-xs text-ink">
        <img class="subagent-avatar" :src="avatarAssets.subagent" alt="" width="24" height="24" />
        <span class="font-semibold">{{ sub.agent_type || 'subagent' }}</span>
        <span class="min-w-0 flex-1 truncate text-muted">{{ sub.purpose }}</span>
        <span class="rounded-full bg-paper2 px-2 py-0.5 text-[10px] text-muted">{{ statusLabel(sub.status) }}</span>
      </summary>
      <div class="mt-2 rounded-2xl bg-paper/75 p-3 text-xs leading-6 text-ink shadow-insetPaper">
        <MarkdownBlock :content="sub.content || sub.error || '思考中...'" />
        <div v-if="sub.summary" class="mt-2 border-t border-line pt-2 text-muted">
          <MarkdownBlock :content="sub.summary" />
        </div>
        <div v-if="sub.tools?.length" class="mt-3 space-y-2">
          <div v-for="tool in sub.tools" :key="tool.id || tool.name" class="mini-tool" :class="tool.status">
            <img class="mini-tool-icon" :src="toolIcon(tool.name)" alt="" width="22" height="22" />
            <div class="min-w-0">
              <div class="flex items-center gap-2 font-semibold">
                <span class="truncate">{{ tool.name }}</span>
                <em class="not-italic text-muted">{{ statusLabel(tool.status) }}</em>
              </div>
              <ExpandableText class="text-muted" :text="tool.summary || fullJson(tool.arguments) || '等待结果...'" :limit="120" />
            </div>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>
