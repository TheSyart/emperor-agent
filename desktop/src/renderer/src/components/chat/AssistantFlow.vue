<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AssistantMessage, AssistantSegment, ThoughtSegment } from '../../types'
import { actionAssets, avatarAssets } from '../../assets'
import MarkdownBlock from './MarkdownBlock.vue'
import TodoPanel from './TodoPanel.vue'
import ToolEvent from './ToolEvent.vue'
import AskCard from './AskCard.vue'
import PlanCard from './PlanCard.vue'
import ThoughtEvent from './ThoughtEvent.vue'

const props = defineProps<{ message: AssistantMessage }>()
const copied = ref(false)

const messageText = computed(() => {
  return props.message.segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.content)
    .join('\n\n')
    .trim()
})

const visibleSegments = computed(() => {
  return props.message.segments.filter((segment) => {
    if (segment.type !== 'thought') return true
    if (segment.status === 'running') return true
    return (segment.durationMs || 0) >= 120
  })
})

const fallbackThought = computed<ThoughtSegment>(() => ({
  id: 'fallback-thought',
  type: 'thought',
  status: 'running',
  startedAt: Date.now(),
  label: '等待模型首字',
}))

const fallbackTodos = computed(() => {
  if (!props.message.todos?.length) return []
  const hasToolTodos = props.message.segments.some((segment) =>
    segment.type === 'tool' && Boolean(segment.todos?.length),
  )
  return hasToolTodos ? [] : props.message.todos
})

function segmentClass(segment: AssistantSegment) {
  if (segment.type === 'text') return 'text-node'
  if (segment.type === 'ask' || segment.type === 'plan') return 'control-node'
  return ''
}

function isStreamingText(segment: AssistantSegment, index: number) {
  return props.message.streaming && segment.type === 'text' && index === visibleSegments.value.length - 1
}

async function copyMessage() {
  const text = messageText.value
  if (!text) return
  await navigator.clipboard?.writeText(text)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1400)
}
</script>

<template>
  <article class="message-row assistant">
    <div class="flow-body timeline-flow">
      <div v-if="messageText" class="assistant-toolbar">
        <div class="message-meta assistant">
          <span aria-hidden="true">
            <img class="assistant-mini-avatar" :src="avatarAssets.eunuch" alt="" />
          </span>
          <small>李 · 回奏</small>
        </div>
        <button class="copy-message-button" type="button" @click="copyMessage">
          <img class="action-icon" :src="actionAssets.copy" alt="" width="16" height="16" />
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
      </div>
      <div v-else class="assistant-toolbar ghost">
        <div class="message-meta assistant">
          <span aria-hidden="true">
            <img class="assistant-mini-avatar" :src="avatarAssets.eunuch" alt="" />
          </span>
          <small>李 · 候旨</small>
        </div>
      </div>

      <div class="assistant-timeline-shell" :class="{ streaming: props.message.streaming }">
        <ThoughtEvent v-if="!visibleSegments.length && props.message.streaming" :segment="fallbackThought" />
        <template v-for="(segment, index) in visibleSegments" :key="segment.id">
          <ThoughtEvent v-if="segment.type === 'thought'" :segment="segment" />
          <div
            v-else-if="segment.type === 'text'"
            class="timeline-node"
            :class="[segmentClass(segment), { streaming: isStreamingText(segment, index) }]"
          >
            <MarkdownBlock :content="segment.content" />
          </div>
          <ToolEvent v-else-if="segment.type === 'tool'" :segment="segment" />
          <div v-else-if="segment.type === 'ask'" class="timeline-node control-node">
            <AskCard :interaction="segment.interaction" />
          </div>
          <div v-else-if="segment.type === 'plan'" class="timeline-node control-node">
            <PlanCard :interaction="segment.interaction" />
          </div>
        </template>
        <div
          v-if="fallbackTodos.length"
          class="timeline-node todo-fallback-node"
        >
          <TodoPanel :todos="fallbackTodos" />
        </div>
      </div>
    </div>
  </article>
</template>
