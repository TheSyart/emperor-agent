<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { SlashCommand } from '../../commands'
import type { AttachmentRef } from '../../types'
import { actionAssets } from '../../assets'
import { uploadAttachment } from '../../api/attachments'
import AttachmentChip from './AttachmentChip.vue'

const props = defineProps<{
  busy: boolean
  commands: SlashCommand[]
  contextUsed: number
  contextMax: number
  supportsVision?: boolean
}>()
const emit = defineEmits<{
  send: [payload: { content: string; attachments: AttachmentRef[] }]
  error: [message: string]
}>()
const value = ref('')
const input = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const drafts = ref<AttachmentRef[]>([])
const uploading = ref<Set<string>>(new Set())
const dragActive = ref(false)

const ACCEPT_LIST =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,application/json,text/csv,text/plain,text/markdown'
const MAX_DRAFTS = 5

const suggestions = computed(() => {
  const text = value.value.trim().toLowerCase()
  if (!text.startsWith('/')) return []
  return props.commands
    .filter((command) => command.name.startsWith(text) || command.aliases?.some((alias) => alias.startsWith(text)))
    .slice(0, 6)
})

const attachTitle = computed(() => {
  if (props.busy) return 'AI 正在执行，等待结束后再添加附件'
  const cap = props.supportsVision ? '当前模型 ✓ 视觉，可发图' : '当前模型未标记视觉，图片会被忽略；文档仍会抽取文本'
  return `添加附件（最多 ${MAX_DRAFTS} 个）· ${cap}`
})

function resize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}

function submit() {
  const content = value.value.trim()
  if (props.busy) return
  if (!content && drafts.value.length === 0) return
  emit('send', { content, attachments: [...drafts.value] })
  value.value = ''
  drafts.value = []
  void nextTick(resize)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab' && suggestions.value.length) {
    event.preventDefault()
    value.value = suggestions.value[0].usage
    void nextTick(resize)
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

function applySuggestion(command: SlashCommand) {
  value.value = command.usage
  input.value?.focus()
  void nextTick(resize)
}

function pickFiles() {
  if (props.busy) return
  fileInput.value?.click()
}

async function handleFiles(files: FileList | File[] | null) {
  if (!files) return
  const slots = MAX_DRAFTS - drafts.value.length
  if (slots <= 0) {
    emit('error', `最多 ${MAX_DRAFTS} 个附件，请先发送或移除已有的`)
    return
  }
  const list = Array.from(files).slice(0, slots)
  for (const f of list) {
    uploading.value.add(f.name)
    try {
      const ref = await uploadAttachment(f)
      drafts.value.push(ref)
    } catch (err) {
      emit('error', err instanceof Error ? err.message : String(err))
    } finally {
      uploading.value.delete(f.name)
    }
  }
}

function onFileInput(e: Event) {
  const target = e.target as HTMLInputElement
  void handleFiles(target.files)
  target.value = ''
}

function onDragEnter(e: DragEvent) {
  if (props.busy) return
  if (!hasFiles(e.dataTransfer)) return
  e.preventDefault()
  dragActive.value = true
}
function onDragOver(e: DragEvent) {
  if (props.busy) return
  if (!hasFiles(e.dataTransfer)) return
  e.preventDefault()
  dragActive.value = true
}
function onDragLeave(e: DragEvent) {
  // 只有真正离开 composer-shell 时才取消高亮
  if (e.target === e.currentTarget) dragActive.value = false
}
function onDrop(e: DragEvent) {
  if (props.busy) return
  e.preventDefault()
  dragActive.value = false
  if (!e.dataTransfer?.files?.length) return
  void handleFiles(e.dataTransfer.files)
}

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types || []).includes('Files')
}

function removeDraft(idx: number) {
  drafts.value.splice(idx, 1)
}

const pct = computed(() => (props.contextMax > 0 ? props.contextUsed / props.contextMax : 0))
const arcLength = computed(() => Math.min(Math.round(pct.value * 100), 100))
const arcColor = computed(() => {
  if (pct.value <= 0.5) return 'rgb(var(--jade))'
  if (pct.value <= 0.8) return 'rgb(var(--amber))'
  return 'rgb(var(--seal))'
})
const percentLabel = computed(() => `${Math.min(Math.round(pct.value * 100), 100)}%`)
const contextLabel = computed(() => `上下文长度 ${fmt(props.contextUsed)} / ${fmt(props.contextMax)}，已用 ${percentLabel.value}`)

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

const sendDisabled = computed(() => props.busy || (!value.value.trim() && drafts.value.length === 0))
</script>

<template>
  <div
    class="composer-shell"
    :class="{ 'composer-drag-active': dragActive }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="suggestions.length" class="slash-menu">
      <button v-for="command in suggestions" :key="command.name" type="button" @click="applySuggestion(command)">
        <strong>{{ command.name }}</strong>
        <span>{{ command.description }}</span>
      </button>
    </div>

    <div v-if="drafts.length || uploading.size" class="composer-drafts">
      <AttachmentChip
        v-for="(d, i) in drafts"
        :key="d.id"
        :data="d"
        removable
        @remove="removeDraft(i)"
      />
      <div v-for="name in Array.from(uploading)" :key="name" class="attach-chip uploading" :title="name">
        <span class="attach-doc-icon">⏳</span>
        <div class="attach-meta">
          <div class="attach-name">{{ name }}</div>
          <div class="attach-sub">上传中…</div>
        </div>
      </div>
    </div>

    <form class="composer" @submit.prevent="submit">
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="ACCEPT_LIST"
        class="hidden-file-input"
        @change="onFileInput"
      />

      <button
        type="button"
        class="attach-button"
        :title="attachTitle"
        :aria-label="attachTitle"
        :disabled="props.busy"
        @click="pickFiles"
      >
        <img class="action-icon" :src="actionAssets.attach" alt="" width="24" height="24" />
      </button>

      <textarea
        ref="input"
        v-model="value"
        rows="1"
        :disabled="props.busy"
        :placeholder="props.busy ? 'AI 正在执行...' : '向李公公交办一件差事... 输入 / 查看命令；可拖入图片或文档'"
        @input="resize"
        @keydown="handleKeydown"
      />

      <div
        v-if="props.contextMax > 0"
        class="context-ring"
        tabindex="0"
        role="status"
        :aria-label="contextLabel"
      >
        <svg viewBox="0 0 36 36" class="ring-svg">
          <circle class="ring-track" cx="18" cy="18" r="15.915" />
          <circle
            class="ring-arc"
            cx="18" cy="18" r="15.915"
            :stroke="arcColor"
            :stroke-dasharray="`${arcLength} ${100 - arcLength}`"
            stroke-dashoffset="25"
          />
        </svg>
        <div class="context-tooltip" role="tooltip">
          <strong>上下文长度</strong>
          <span>{{ fmt(props.contextUsed) }} / {{ fmt(props.contextMax) }}</span>
          <em>已用 {{ percentLabel }}</em>
        </div>
      </div>

      <button class="send-button" :disabled="sendDisabled" type="submit">
        <img class="action-icon send-icon" :src="props.busy ? actionAssets.statusBusy : actionAssets.send" alt="" width="24" height="24" />
        <span class="sr-only">{{ props.busy ? '等待' : '发送' }}</span>
      </button>
    </form>
  </div>
</template>
