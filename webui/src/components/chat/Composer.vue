<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { SlashPaletteItem } from '../../commands'
import type { AttachmentRef } from '../../types'
import { actionAssets, toolAssets } from '../../assets'
import { uploadAttachment } from '../../api/attachments'
import AttachmentChip from './AttachmentChip.vue'

const props = defineProps<{
  busy: boolean
  commands: SlashPaletteItem[]
  contextUsed: number
  contextMax: number
  controlMode?: string
  supportsVision?: boolean
}>()
const emit = defineEmits<{
  send: [payload: { content: string; attachments: AttachmentRef[] }]
  error: [message: string]
  'set-mode': [mode: 'normal' | 'plan']
}>()
const value = ref('')
const input = ref<HTMLTextAreaElement | null>(null)
const highlightLayer = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const drafts = ref<AttachmentRef[]>([])
const uploading = ref<Set<string>>(new Set())
const dragActive = ref(false)
const modeMenuOpen = ref(false)

const ACCEPT_LIST =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,application/json,text/csv,text/plain,text/markdown'
const MAX_DRAFTS = 5

const suggestions = computed(() => {
  const text = value.value
  if (!text.startsWith('/')) return []
  if (/^\/\S+\s/.test(text)) return []
  const query = text.slice(1).split(/\s+/, 1)[0].toLowerCase()
  return props.commands
    .filter((item) => {
      if (!query) return true
      const haystack = [
        item.name,
        item.usage,
        item.description,
        item.tags || '',
        ...(item.aliases || []),
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    })
})
const commandSuggestions = computed(() => suggestions.value.filter((item) => item.kind === 'command'))
const skillSuggestions = computed(() => suggestions.value.filter((item) => item.kind === 'skill'))
const composerSlashParts = computed((): { token: string; rest: string } | null => {
  const text = value.value
  if (!text.startsWith('/')) return null
  const token = text.match(/^\/\S+/)?.[0]
  if (!token || token === '/') return null
  const normalized = token.toLowerCase()
  const isSystemCommand = props.commands.some((item) =>
    item.kind === 'command' && (item.name === normalized || item.aliases?.includes(normalized)),
  )
  if (isSystemCommand) return null
  return { token, rest: text.slice(token.length) }
})

const attachTitle = computed(() => {
  if (props.busy) return 'AI 正在执行，等待结束后再添加附件'
  const cap = props.supportsVision ? '当前模型 ✓ 视觉，可发图' : '当前模型未标记视觉，图片会被忽略；文档仍会抽取文本'
  return `添加附件（最多 ${MAX_DRAFTS} 个）· ${cap}`
})

const modeOptions = [
  {
    value: 'normal',
    label: '正常模式',
    short: '正常',
    description: '直接执行工具与代码改动',
    icon: actionAssets.statusOnline,
  },
  {
    value: 'plan',
    label: '计划模式',
    short: '计划',
    description: '只读探索，提交计划，批准后执行',
    icon: toolAssets.todo,
  },
] as const

const currentMode = computed(() => modeOptions.find((item) => item.value === props.controlMode) || modeOptions[0])
const modeTitle = computed(() => props.busy ? 'AI 正在执行，结束后再切换模式' : '切换对话模式')

function resize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  syncHighlightScroll()
}

function syncHighlightScroll() {
  if (!input.value || !highlightLayer.value) return
  highlightLayer.value.scrollTop = input.value.scrollTop
}

function submit() {
  const content = value.value.trim()
  if (props.busy) return
  if (!content && drafts.value.length === 0) return
  emit('send', {
    content,
    attachments: [...drafts.value],
  })
  value.value = ''
  drafts.value = []
  modeMenuOpen.value = false
  void nextTick(resize)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab' && suggestions.value.length) {
    event.preventDefault()
    applySuggestion(suggestions.value[0])
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

function applySuggestion(command: SlashPaletteItem) {
  value.value = command.completion
  modeMenuOpen.value = false
  input.value?.focus()
  void nextTick(resize)
}

function showSlashCommands() {
  if (props.busy) return
  if (!value.value.trim()) value.value = '/'
  modeMenuOpen.value = false
  input.value?.focus()
  void nextTick(resize)
}

function toggleModeMenu() {
  if (props.busy) return
  modeMenuOpen.value = !modeMenuOpen.value
}

function selectMode(mode: 'normal' | 'plan') {
  if (props.busy) return
  modeMenuOpen.value = false
  if (mode !== props.controlMode) emit('set-mode', mode)
  input.value?.focus()
}

function scheduleModeMenuClose() {
  window.setTimeout(() => {
    modeMenuOpen.value = false
  }, 140)
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
      <div class="slash-menu-head">
        <span>斜杠命令</span>
        <em>Tab 补全第一项</em>
      </div>

      <div v-if="commandSuggestions.length" class="slash-menu-group">
        <div class="slash-menu-label">命令</div>
        <button
          v-for="command in commandSuggestions"
          :key="command.id"
          type="button"
          class="slash-menu-item"
          :data-kind="command.kind"
          @click="applySuggestion(command)"
        >
          <strong>{{ command.name }}</strong>
          <span>{{ command.description }}</span>
          <b>{{ command.usage }}</b>
        </button>
      </div>

      <div v-if="skillSuggestions.length" class="slash-menu-group">
        <div class="slash-menu-label">Skills</div>
        <button
          v-for="skill in skillSuggestions"
          :key="skill.id"
          type="button"
          class="slash-menu-item"
          :data-kind="skill.kind"
          @click="applySuggestion(skill)"
        >
          <strong>{{ skill.name }}</strong>
          <span>{{ skill.description }}</span>
          <b>{{ skill.tags || 'Skill' }}</b>
        </button>
      </div>
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

    <form class="composer" @submit.prevent="submit" @keydown.esc="modeMenuOpen = false">
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="ACCEPT_LIST"
        class="hidden-file-input"
        @change="onFileInput"
      />

      <div class="composer-input-row">
        <div class="composer-textarea-wrap" :class="{ 'has-skill-slash': composerSlashParts }">
          <div v-if="composerSlashParts" ref="highlightLayer" class="composer-highlight-layer" aria-hidden="true">
            <span class="composer-skill-slash">{{ composerSlashParts.token }}</span><span>{{ composerSlashParts.rest }}</span>
          </div>
          <textarea
            ref="input"
            v-model="value"
            rows="2"
            :disabled="props.busy"
            :placeholder="props.busy ? 'AI 正在执行...' : '向李公公交办一件差事... 输入 / 查看命令；可拖入图片或文档'"
            @focus="modeMenuOpen = false"
            @input="resize"
            @scroll="syncHighlightScroll"
            @keydown="handleKeydown"
          />
        </div>
      </div>

      <div class="composer-action-row">
        <div class="composer-left-actions">
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

          <button
            type="button"
            class="slash-hint-button"
            title="显示斜杠命令"
            :disabled="props.busy"
            @click="showSlashCommands"
          >
            <span>/</span>
            <em>命令</em>
          </button>
        </div>

        <div class="composer-right-actions">
          <div class="mode-picker" @focusout="scheduleModeMenuClose">
            <button
              type="button"
              class="mode-button"
              :data-active="currentMode.value === 'plan'"
              :aria-expanded="modeMenuOpen"
              :title="modeTitle"
              :disabled="props.busy"
              @click="toggleModeMenu"
            >
              <img class="mode-icon" :src="currentMode.icon" alt="" width="18" height="18" />
              <span>{{ currentMode.label }}</span>
              <em>{{ currentMode.value === 'plan' ? '预览计划' : '直接执行' }}</em>
              <img class="mode-caret" :src="actionAssets.caretDown" alt="" width="14" height="14" />
            </button>

            <div v-if="modeMenuOpen" class="mode-menu">
              <div class="mode-menu-head">
                <span>对话模式</span>
                <em>切换后立即生效</em>
              </div>
              <button
                v-for="option in modeOptions"
                :key="option.value"
                type="button"
                class="mode-option"
                :data-active="currentMode.value === option.value"
                @click="selectMode(option.value)"
              >
                <img class="mode-option-icon" :src="option.icon" alt="" width="20" height="20" />
                <span>
                  <strong>{{ option.label }}</strong>
                  <small>{{ option.description }}</small>
                </span>
                <b>{{ option.short }}</b>
              </button>
            </div>
          </div>

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
        </div>
      </div>
    </form>
  </div>
</template>
