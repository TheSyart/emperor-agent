<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AssistantMessage, ThoughtSegment } from '../../types'
import { actionIcons, avatarIcons } from '../../icons'
import MarkdownBlock from './MarkdownBlock.vue'
import TodoPanel from './TodoPanel.vue'
import ToolGroup from './ToolGroup.vue'
import AskCard from './AskCard.vue'
import PlanCard from './PlanCard.vue'
import ThoughtEvent from './ThoughtEvent.vue'
import { projectAssistantFlow } from './assistantFlowProjection'

const props = defineProps<{ message: AssistantMessage }>()
const copied = ref(false)

const messageText = computed(() => {
  return props.message.segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.content)
    .join('\n\n')
    .trim()
})

const flowBlocks = computed(() => projectAssistantFlow(props.message))

const fallbackThought = computed<ThoughtSegment>(() => ({
  id: 'fallback-thought',
  type: 'thought',
  status: 'running',
  startedAt: Date.now(),
  label: '等待模型首字',
}))

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
            <component :is="avatarIcons.eunuch" class="assistant-mini-avatar" :size="16" />
          </span>
          <small>李 · 回奏</small>
        </div>
        <button class="copy-message-button" type="button" @click="copyMessage">
          <component :is="actionIcons.copy" class="action-icon" :size="14" />
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
      </div>
      <div v-else class="assistant-toolbar ghost">
        <div class="message-meta assistant">
          <span aria-hidden="true">
            <component :is="avatarIcons.eunuch" class="assistant-mini-avatar" :size="16" />
          </span>
          <small>李 · 候旨</small>
        </div>
      </div>

      <div class="assistant-timeline-shell" :class="{ streaming: props.message.streaming }">
        <ThoughtEvent v-if="!flowBlocks.length && props.message.streaming" :segment="fallbackThought" />
        <template v-for="block in flowBlocks" :key="block.id">
          <ThoughtEvent v-if="block.kind === 'thought'" :segment="block.segment" />
          <div
            v-else-if="block.kind === 'text'"
            class="timeline-node text-node"
            :class="{ streaming: block.streaming }"
          >
            <MarkdownBlock :content="block.content" />
          </div>
          <ToolGroup v-else-if="block.kind === 'tool_group'" :block="block" />
          <div v-else-if="block.kind === 'control' && block.segment.type === 'ask'" class="timeline-node control-node">
            <AskCard :interaction="block.segment.interaction" />
          </div>
          <div v-else-if="block.kind === 'control' && block.segment.type === 'plan'" class="timeline-node control-node">
            <PlanCard :interaction="block.segment.interaction" />
          </div>
          <div v-else-if="block.kind === 'todos'" class="timeline-node todo-fallback-node">
            <TodoPanel :todos="block.todos" />
          </div>
        </template>
      </div>
    </div>
  </article>
</template>
