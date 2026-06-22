<script setup lang="ts">
import type { SubagentState, ToolStatus } from '../../types'
import { compactJson } from '../../utils/format'
import { avatarIcons, toolIcon } from '../../icons'
import ExpandableText from './ExpandableText.vue'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ subagents: SubagentState[] }>()

function statusLabel(status?: ToolStatus) {
  if (status === 'done') return '完成'
  if (status === 'error') return '出错'
  if (status === 'error_aborted') return '已中断'
  return '执行中'
}

function agentTitle(sub: SubagentState) {
  if (sub.kind === 'team') return `队友 ${sub.id || sub.agent_type || ''}`.trim()
  return sub.agent_type || 'subagent'
}

function agentKind(sub: SubagentState) {
  return sub.kind === 'team' ? 'Team Agent' : 'Agent'
}

function durationLabel(ms?: number) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function messageTitle(msg: { from: string; to: string; type: string }) {
  if (msg.to === 'lead') return `${msg.from} 回禀`
  if (msg.from === 'lead') return 'Lead 指令'
  return `${msg.from} -> ${msg.to}`
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
  <div class="agent-timeline">
    <details
      v-for="sub in props.subagents"
      :key="sub.id || sub.agent_type"
      class="agent-node"
      :class="[sub.status, sub.kind || 'subagent']"
      open
    >
      <summary class="agent-node-head">
        <component :is="avatarIcons.subagent" class="subagent-avatar" :size="16" />
        <span class="agent-node-title">
          <span>{{ agentKind(sub) }}</span>
          <strong>Agent: {{ agentTitle(sub) }}</strong>
          <small v-if="sub.purpose">{{ sub.purpose }}</small>
        </span>
        <span v-if="sub.role" class="agent-role-badge">{{ sub.role }}</span>
        <span class="agent-state-badge">{{ statusLabel(sub.status) }}</span>
        <time v-if="durationLabel(sub.durationMs)" class="agent-duration">{{ durationLabel(sub.durationMs) }}</time>
      </summary>

      <div class="agent-node-body">
        <div v-if="sub.content || sub.error" class="agent-thinking">
          <MarkdownBlock :content="sub.content || sub.error || ''" />
        </div>

        <div v-if="sub.messages?.length" class="agent-message-stack">
          <div v-for="msg in sub.messages" :key="msg.id" class="agent-message" :class="[msg.type, msg.to === 'lead' ? 'to-lead' : 'to-member']">
            <div class="agent-message-head">
              <strong>{{ messageTitle(msg) }}</strong>
              <span>{{ msg.type }}</span>
            </div>
            <p>{{ msg.content }}</p>
          </div>
        </div>

        <div v-if="sub.summary" class="agent-summary">
          <MarkdownBlock :content="sub.summary" />
        </div>

        <div v-if="sub.tools?.length" class="agent-tool-list">
          <div v-for="tool in sub.tools" :key="tool.id || tool.name" class="mini-tool" :class="tool.status">
            <component :is="toolIcon(tool.name)" class="mini-tool-icon" :size="14" />
            <div class="mini-tool-main">
              <div class="mini-tool-head">
                <span>{{ tool.name }}</span>
                <em>{{ statusLabel(tool.status) }}</em>
                <time v-if="durationLabel(tool.durationMs)">{{ durationLabel(tool.durationMs) }}</time>
              </div>
              <ExpandableText class="text-muted" :text="tool.summary || fullJson(tool.arguments) || '等待结果...'" :limit="120" />
            </div>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>
