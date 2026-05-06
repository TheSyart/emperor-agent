<script setup lang="ts">
import { ref } from 'vue'
import type { AssistantMessage } from '../../types'
import { actionAssets, avatarAssets } from '../../assets'
import MarkdownBlock from './MarkdownBlock.vue'
import TodoPanel from './TodoPanel.vue'
import ToolEvent from './ToolEvent.vue'

const props = defineProps<{ message: AssistantMessage }>()
const copied = ref(false)

function messageText() {
  return props.message.segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.content)
    .join('\n\n')
    .trim()
}

async function copyMessage() {
  const text = messageText()
  if (!text) return
  await navigator.clipboard?.writeText(text)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1400)
}
</script>

<template>
  <article class="message-row assistant">
    <div class="avatar assistant">
      <img class="pixel-avatar" :src="avatarAssets.eunuch" alt="大内总管" width="40" height="40" />
    </div>
    <div class="flow-body">
      <button v-if="messageText()" class="copy-message-button" type="button" @click="copyMessage">
        <img class="action-icon" :src="actionAssets.copy" alt="" width="16" height="16" />
        <span>{{ copied ? '已复制' : '复制回复' }}</span>
      </button>
      <template v-if="!props.message.segments.length && props.message.streaming">
        <div class="bubble assistant streaming">正在思量...</div>
      </template>
      <template v-for="(segment, index) in props.message.segments" :key="segment.id">
        <div
          v-if="segment.type === 'text'"
          class="bubble assistant"
          :class="{ streaming: props.message.streaming && index === props.message.segments.length - 1 }"
        >
          <MarkdownBlock :content="segment.content" />
        </div>
        <ToolEvent v-else :segment="segment" />
      </template>
      <TodoPanel v-if="props.message.todos?.length" :todos="props.message.todos" />
    </div>
  </article>
</template>
