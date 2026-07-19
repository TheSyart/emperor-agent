<script setup lang="ts">
import {
  hasComposerCapabilityTokens,
  renderComposerInlineTokens,
} from '../../capabilities/composerCapabilityTokens'
import { isPathLikeSlashToken, slashCommands } from '../../commands'
import type { ChatMessage, RuntimePlanRecord, UserMessage } from '../../types'
import { avatarIcons } from '../../icons'
import AssistantFlow from './AssistantFlow.vue'
import AttachmentChip from './AttachmentChip.vue'

const props = defineProps<{
  message: ChatMessage
  plans: RuntimePlanRecord[]
}>()
const schedulerClientIdPrefix = 'scheduler:'
const schedulerTriggerPrefixes = ['定时任务触发 ·', '司时台触发 ·']

function skillSlashParts(
  message: UserMessage,
): { token: string; rest: string } | null {
  const text = message.content.trim()
  if (!text.startsWith('/')) return null
  const [token] = text.split(/\s+/, 1)
  if (!token || token === '/') return null
  if (isPathLikeSlashToken(token)) return null
  const normalized = token.toLowerCase()
  const isSystemCommand = slashCommands.some(
    (command) =>
      command.name === normalized || command.aliases?.includes(normalized),
  )
  if (isSystemCommand) return null
  return { token, rest: text.slice(token.length).trimStart() }
}

function hasInlineTokens(message: UserMessage): boolean {
  return hasComposerCapabilityTokens(message.content)
}

function inlineTokenParts(message: UserMessage) {
  return renderComposerInlineTokens(message.content)
}

function isSchedulerMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  const displayPrefix = schedulerTriggerPrefix(message.content)
  return (
    message.source === 'scheduler' ||
    message.id.startsWith(schedulerClientIdPrefix) ||
    Boolean(displayPrefix)
  )
}

function schedulerDisplayParts(message: ChatMessage): {
  jobName: string
  body: string
} {
  if (message.role !== 'user') return { jobName: '定时任务', body: '' }
  const text = message.content.trimStart()
  const displayPrefix = schedulerTriggerPrefix(text)
  let jobName = message.scheduler?.jobName || ''
  let body = message.content
  if (displayPrefix) {
    const firstBreak = text.search(/\r?\n/)
    const header = firstBreak >= 0 ? text.slice(0, firstBreak) : text
    const parsedName = header.slice(displayPrefix.length).trim()
    if (!jobName && parsedName) jobName = parsedName
    const separator = text.match(/\r?\n\r?\n/)
    body =
      separator?.index !== undefined
        ? text.slice(separator.index + separator[0].length).trim()
        : text.slice(header.length).trim()
  }
  return { jobName: jobName || '定时任务', body }
}

function schedulerTriggerPrefix(content: string) {
  const text = content.trimStart()
  return (
    schedulerTriggerPrefixes.find((prefix) => text.startsWith(prefix)) || ''
  )
}

function deliveryLabel(message: UserMessage): string {
  if (message.deliveryState === 'queued') return '已排队'
  if (message.deliveryState === 'running') return '处理中'
  if (message.deliveryState === 'interjected') return '已插话'
  if (message.deliveryState === 'cancelled') return '已取消'
  return ''
}
</script>

<template>
  <article
    v-if="isSchedulerMessage(props.message)"
    class="message-row scheduler-trigger"
  >
    <div class="scheduler-trigger-card">
      <div class="scheduler-trigger-head">
        <span class="scheduler-trigger-icon" aria-hidden="true">定</span>
        <div class="min-w-0">
          <div class="scheduler-trigger-title">定时任务触发</div>
          <div class="scheduler-trigger-name">
            {{ schedulerDisplayParts(props.message).jobName }}
          </div>
        </div>
      </div>
      <div
        v-if="schedulerDisplayParts(props.message).body"
        class="scheduler-trigger-body whitespace-pre-wrap"
      >
        {{ schedulerDisplayParts(props.message).body }}
      </div>
    </div>
  </article>
  <article v-else-if="props.message.role === 'user'" class="message-row user">
    <div class="avatar user" aria-hidden="true">
      <component :is="avatarIcons.emperor" :size="16" />
    </div>
    <div class="message-cluster user">
      <div class="message-meta user">
        <span>你</span><small>request</small>
        <small
          v-if="props.message.deliveryState"
          class="prompt-delivery-state"
          :data-state="props.message.deliveryState"
          :title="props.message.deliveryReason || deliveryLabel(props.message)"
        >
          {{ deliveryLabel(props.message) }}
        </small>
      </div>
      <div v-if="props.message.attachments?.length" class="user-attach-row">
        <AttachmentChip
          v-for="attachment in props.message.attachments"
          :key="attachment.id"
          :data="attachment"
        />
      </div>
      <div v-if="props.message.content" class="bubble user whitespace-pre-wrap">
        <template v-if="hasInlineTokens(props.message)">
          <template
            v-for="(segment, index) in inlineTokenParts(props.message)"
            :key="index"
          >
            <span
              v-if="segment.kind === 'token'"
              class="user-inline-token"
              :data-kind="segment.tokenKind"
            >
              {{ segment.tokenKind === 'skill' ? 'Skill' : 'MCP' }} ·
              {{ segment.name }}
            </span>
            <span v-else>{{ segment.text }}</span>
          </template>
        </template>
        <template v-else-if="skillSlashParts(props.message)">
          <span class="user-skill-slash">{{
            skillSlashParts(props.message)?.token
          }}</span>
          <span v-if="skillSlashParts(props.message)?.rest">
            {{ skillSlashParts(props.message)?.rest }}</span
          >
        </template>
        <template v-else>{{ props.message.content }}</template>
      </div>
    </div>
  </article>
  <AssistantFlow v-else :message="props.message" :plans="props.plans" />
</template>
