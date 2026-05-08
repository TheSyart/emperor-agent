<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { ChatMessage } from '../../types'
import { avatarAssets, brandAssets, emptyAssets } from '../../assets'
import AssistantFlow from './AssistantFlow.vue'
import AttachmentChip from './AttachmentChip.vue'

const props = defineProps<{ messages: ChatMessage[] }>()
const scroller = ref<HTMLElement | null>(null)

function pinToBottom() {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => props.messages,
  () => nextTick(pinToBottom),
  { deep: true, flush: 'post' },
)
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
        <article v-if="message.role === 'user'" class="message-row user">
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
            <div v-if="message.content" class="bubble user whitespace-pre-wrap">{{ message.content }}</div>
          </div>
        </article>
        <AssistantFlow v-else :message="message" />
      </template>
    </div>
  </section>
</template>
