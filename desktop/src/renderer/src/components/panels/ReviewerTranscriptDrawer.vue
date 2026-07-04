<script setup lang="ts">
import { ref, watch } from 'vue'
import { core } from '../../api/http'

const props = defineProps<{ open: boolean; taskId: string }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

interface TranscriptResponse {
  transcript?: { messages?: Array<Record<string, unknown>> }
}

const messages = ref<Array<Record<string, unknown>>>([])
const loading = ref(false)
const error = ref('')

async function load() {
  if (!props.taskId) return
  loading.value = true
  error.value = ''
  try {
    const data = await core<TranscriptResponse>('tasks.transcript', props.taskId, { limit: 200 })
    messages.value = data?.transcript?.messages || []
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

function rowLabel(msg: Record<string, unknown>): string {
  return String(msg.role || msg.event || 'event')
}

function rowContent(msg: Record<string, unknown>): string {
  return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg, null, 2)
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) load()
  },
)
</script>

<template>
  <div v-if="open" class="drawer-backdrop" @click.self="emit('update:open', false)">
    <aside class="drawer reviewer-transcript-drawer">
      <header class="drawer-head">
        <h3>复核 Transcript</h3>
        <button class="tool-button" @click="emit('update:open', false)">关闭</button>
      </header>
      <div v-if="loading" class="drawer-body">加载中…</div>
      <div v-else-if="error" class="drawer-body drawer-error">{{ error }}</div>
      <div v-else-if="!messages.length" class="drawer-body">暂无 transcript 记录</div>
      <ol v-else class="drawer-body">
        <li v-for="(msg, i) in messages" :key="i" class="transcript-row">
          <span class="transcript-role">{{ rowLabel(msg) }}</span>
          <pre class="transcript-content">{{ rowContent(msg) }}</pre>
        </li>
      </ol>
    </aside>
  </div>
</template>
