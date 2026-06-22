<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { slashCommands } from '../../commands'
import type { ChatMessage, UserMessage } from '../../types'
import { avatarAssets, brandAssets, emptyAssets } from '../../assets'
import AssistantFlow from './AssistantFlow.vue'
import AttachmentChip from './AttachmentChip.vue'

const props = defineProps<{ messages: ChatMessage[] }>()
const scroller = ref<HTMLElement | null>(null)
const schedulerClientIdPrefix = 'scheduler:'
const schedulerTriggerPrefixes = ['定时任务触发 ·', '司时台触发 ·']

function pinToBottom() {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => props.messages,
  () => nextTick(pinToBottom),
  { deep: true, flush: 'post' },
)

function skillSlashParts(message: UserMessage): { token: string; rest: string } | null {
  const text = message.content.trim()
  if (!text.startsWith('/')) return null
  const [token] = text.split(/\s+/, 1)
  if (!token || token === '/') return null
  const normalized = token.toLowerCase()
  const isSystemCommand = slashCommands.some((command) =>
    command.name === normalized || command.aliases?.includes(normalized),
  )
  if (isSystemCommand) return null
  return { token, rest: text.slice(token.length).trimStart() }
}

function isSchedulerMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  const displayPrefix = schedulerTriggerPrefix(message.content)
  return message.source === 'scheduler' ||
    message.id.startsWith(schedulerClientIdPrefix) ||
    Boolean(displayPrefix)
}

function schedulerDisplayParts(message: ChatMessage): { jobName: string; body: string } {
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
    body = separator?.index !== undefined
      ? text.slice(separator.index + separator[0].length).trim()
      : text.slice(header.length).trim()
  }
  return { jobName: jobName || '定时任务', body }
}

function schedulerTriggerPrefix(content: string) {
  const text = content.trimStart()
  return schedulerTriggerPrefixes.find((prefix) => text.startsWith(prefix)) || ''
}
</script>

<template>
  <section ref="scroller" class="messages-pane">
    <div v-if="!props.messages.length" class="welcome-card animate-rise-in">
      <div class="mb-4 flex items-center gap-3 text-sm text-seal">
        <img class="brand-seal-sm" :src="brandAssets.logoMark" alt="令" width="28" height="28" />
        <span>大内总管待命</span>
      </div>
      <div class="welcome-layout">
        <div>
          <h1>下旨即可开工。</h1>
          <p>这里是一条主线，不再区分会话。右侧工作台负责模型厂家、Token 账本、Skill、Tool 和配置文件。</p>
        </div>
        <img class="welcome-hero" :src="emptyAssets.welcome" alt="御前智能体待命" />
      </div>
    </div>

    <div class="message-stack">
      <template v-for="message in props.messages" :key="message.id">
        <article v-if="isSchedulerMessage(message)" class="message-row scheduler-trigger">
          <div class="scheduler-trigger-card">
            <div class="scheduler-trigger-head">
              <span class="scheduler-trigger-icon" aria-hidden="true">定</span>
              <div class="min-w-0">
                <div class="scheduler-trigger-title">定时任务触发</div>
                <div class="scheduler-trigger-name">{{ schedulerDisplayParts(message).jobName }}</div>
              </div>
            </div>
            <div v-if="schedulerDisplayParts(message).body" class="scheduler-trigger-body whitespace-pre-wrap">
              {{ schedulerDisplayParts(message).body }}
            </div>
          </div>
        </article>
        <article v-else-if="message.role === 'user'" class="message-row user">
          <div class="avatar user" aria-hidden="true">
            <img class="pixel-avatar" :src="avatarAssets.emperor" alt="" />
          </div>
          <div class="message-cluster user">
            <div class="message-meta user"><span>皇</span><small>圣旨</small></div>
            <div v-if="message.attachments?.length" class="user-attach-row">
              <AttachmentChip
                v-for="attachment in message.attachments"
                :key="attachment.id"
                :data="attachment"
              />
            </div>
            <div v-if="message.content" class="bubble user whitespace-pre-wrap">
              <template v-if="skillSlashParts(message)">
                <span class="user-skill-slash">{{ skillSlashParts(message)?.token }}</span>
                <span v-if="skillSlashParts(message)?.rest"> {{ skillSlashParts(message)?.rest }}</span>
              </template>
              <template v-else>{{ message.content }}</template>
            </div>
          </div>
        </article>
        <AssistantFlow v-else :message="message" />
      </template>
    </div>
  </section>
</template>
