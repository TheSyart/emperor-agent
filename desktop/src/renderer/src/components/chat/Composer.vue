<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { CapabilityPickerItem } from '../../capabilities/capabilityPicker'
import { buildCapabilityPickerGroups } from '../../capabilities/capabilityPickerModel'
import {
  hasComposerCapabilityTokens,
  normalizeComposerCapabilityInput,
  renderComposerInlineTokens,
} from '../../capabilities/composerCapabilityTokens'
import { isPathLikeSlashToken } from '../../commands'
import type { SlashPaletteItem } from '../../commands'
import type { AttachmentRef, ChatSendPayload, CurrentModelConfig, ModelEntry, ToolInfo } from '../../types'
import { actionIcons, modelIcons, toolIcon } from '../../icons'
import type { IconComponent } from '../../icons'
import { uploadAttachment } from '../../api/attachments'
import AttachmentChip from './AttachmentChip.vue'
import CapabilityPicker from './CapabilityPicker.vue'
import { composerSendDisabled } from './composerControls'
import { useFloatingMenu } from './floatingMenu'

const props = defineProps<{
  busy: boolean
  commands: SlashPaletteItem[]
  tools: ToolInfo[]
  mcpContent?: string
  contextUsed: number
  contextMax: number
  controlMode?: string
  currentModel?: CurrentModelConfig | null
  modelEntries: ModelEntry[]
  supportsVision?: boolean
}>()
const emit = defineEmits<{
  send: [payload: ChatSendPayload]
  stop: []
  error: [message: string]
  'set-mode': [mode: 'ask_before_edit' | 'auto' | 'plan']
  'switch-model': [entryName: string]
  'set-reasoning-effort': [level: string | null]
}>()
const value = ref('')
const shell = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
const highlightLayer = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const modelButton = ref<HTMLButtonElement | null>(null)
const modelMenu = ref<HTMLElement | null>(null)
const modeButton = ref<HTMLButtonElement | null>(null)
const modeMenu = ref<HTMLElement | null>(null)
const drafts = ref<AttachmentRef[]>([])
const uploading = ref<Set<string>>(new Set())
const dragActive = ref(false)
const addMenuOpen = ref(false)
const modelMenuOpen = ref(false)
const modeMenuOpen = ref(false)
const modelFloatingMenu = useFloatingMenu({
  open: modelMenuOpen,
  button: modelButton,
  menu: modelMenu,
  fallbackWidth: 390,
  fallbackHeight: 260,
  onClose: closeModelMenu,
})
const modeFloatingMenu = useFloatingMenu({
  open: modeMenuOpen,
  button: modeButton,
  menu: modeMenu,
  fallbackWidth: 320,
  fallbackHeight: 220,
  onClose: closeModeMenu,
})
const modelMenuStyle = modelFloatingMenu.style
const modelMenuPlacement = modelFloatingMenu.placement
const modeMenuStyle = modeFloatingMenu.style
const modeMenuPlacement = modeFloatingMenu.placement

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
const slashPaletteGroups = computed(() => [
  {
    label: '命令',
    items: commandSuggestions.value.map((item) => paletteItemFromSlash(item, '命令')),
  },
  {
    label: 'Skills',
    items: skillSuggestions.value.map((item) => paletteItemFromSlash(item, 'Skill')),
  },
].filter((group) => group.items.length))
const addPaletteGroups = computed(() => buildCapabilityPickerGroups({
  commands: props.commands,
  tools: props.tools,
  mcpContent: props.mcpContent || '',
}))
const paletteMode = computed<'add' | 'slash' | null>(() => {
  if (addMenuOpen.value) return 'add'
  if (slashPaletteGroups.value.length) return 'slash'
  return null
})
const paletteGroups = computed(() => paletteMode.value === 'add' ? addPaletteGroups.value : slashPaletteGroups.value)
const paletteHeading = computed(() => paletteMode.value === 'add' ? '添加能力' : '斜杠命令')
const paletteHint = computed(() => paletteMode.value === 'add' ? '插入附件、Skill 或 MCP 占位符' : 'Tab 补全第一项')
const inlineSegments = computed(() => renderComposerInlineTokens(value.value))
const hasInlineTokens = computed(() => hasComposerCapabilityTokens(value.value))
const composerSlashParts = computed((): { token: string; rest: string } | null => {
  const text = value.value
  if (!text.startsWith('/')) return null
  const token = text.match(/^\/\S+/)?.[0]
  if (!token || token === '/') return null
  if (isPathLikeSlashToken(token)) return null
  const normalized = token.toLowerCase()
  const isSystemCommand = props.commands.some((item) =>
    item.kind === 'command' && (item.name === normalized || item.aliases?.includes(normalized)),
  )
  if (isSystemCommand) return null
  return { token, rest: text.slice(token.length) }
})

const attachTitle = computed(() => props.busy ? '等待当前任务结束后再添加' : 'Add files and more')

const modeOptions = [
  {
    value: 'ask_before_edit',
    label: '询问确认',
    short: '询问',
    description: '高风险或不确定操作前先确认',
    icon: actionIcons.modeAskBeforeEdit,
  },
  {
    value: 'auto',
    label: '自动执行',
    short: '自动',
    description: '在当前权限下直接推进任务',
    icon: actionIcons.modeAuto,
  },
  {
    value: 'plan',
    label: '计划预览',
    short: '计划',
    description: '先只读探索，再提交计划审批',
    icon: actionIcons.modePlan,
  },
] as const

const normalizedControlMode = computed(() => props.controlMode === 'normal' ? 'ask_before_edit' : props.controlMode)
const currentMode = computed(() => modeOptions.find((item) => item.value === normalizedControlMode.value) || modeOptions[0])
const modeTitle = computed(() => props.busy ? '等待当前任务结束后再切换' : '切换执行方式')
const availableModelEntries = computed(() => props.modelEntries.filter((entry) => entry.name))
const activeModelName = computed(() =>
  props.currentModel?.entryName || props.modelEntries[0]?.name || '',
)
const currentModelEntry = computed(() =>
  availableModelEntries.value.find((entry) => entry.name === activeModelName.value) ||
  availableModelEntries.value[0] ||
  null,
)
const showModelSwitcher = computed(() => availableModelEntries.value.length > 0)
const currentModelLabel = computed(() => {
  const entry = currentModelEntry.value
  if (entry) return entry.label || entry.name
  return props.currentModel?.entryLabel || props.currentModel?.entryName || props.currentModel?.model || '模型'
})
const currentReasoningLabel = computed(() =>
  reasoningLabel(props.currentModel?.reasoningEffort ?? currentModelEntry.value?.reasoningEffort ?? null),
)
const currentReasoningValue = computed(() =>
  normalizeReasoningValue(props.currentModel?.reasoningEffort ?? currentModelEntry.value?.reasoningEffort ?? null),
)
const modelTitle = computed(() => {
  if (props.busy) return '等待当前任务结束后再切换模型'
  return `${currentModelLabel.value} · 思考 ${currentReasoningLabel.value}`
})
const reasoningOptions = [
  { value: null, label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
] as const

function paletteItemFromSlash(item: SlashPaletteItem, meta: string): CapabilityPickerItem {
  const skillName = item.skillName || item.name.replace(/^\//, '')
  return {
    id: item.id,
    action: item.kind === 'skill' ? 'insert_capability_token' : 'insert_command',
    label: item.name,
    description: item.description,
    meta: item.kind === 'skill' ? (item.tags || meta) : item.usage,
    completion: item.kind === 'skill' ? `@skill(${skillName})` : item.completion,
    icon: item.kind === 'skill' ? toolIcon('skill') : commandIcon(item.name),
    tone: item.kind === 'skill' ? 'cyan' : 'slate',
  }
}

function commandIcon(name: string): IconComponent {
  if (name === '/plan') return actionIcons.modePlan
  if (name === '/mode') return actionIcons.modeAskBeforeEdit
  if (name === '/tools') return toolIcon('default')
  if (name === '/skills') return toolIcon('skill')
  if (name === '/status') return actionIcons.statusOnline
  return toolIcon('shell')
}

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
  if (props.busy) return
  const normalized = normalizeComposerCapabilityInput(value.value.trim())
  const content = normalized.content.trim()
  if (!content && drafts.value.length === 0) return
  emit('send', {
    content,
    attachments: [...drafts.value],
    requestedSkills: normalized.requestedSkills,
    displayContent: normalized.displayContent,
  })
  value.value = ''
  drafts.value = []
  closeAddMenu()
  closeModelMenu()
  closeModeMenu()
  void nextTick(resize)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab' && firstPaletteItem.value) {
    event.preventDefault()
    applyPaletteItem(firstPaletteItem.value)
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

const firstPaletteItem = computed(() => paletteGroups.value[0]?.items[0])

function applyPaletteItem(item: CapabilityPickerItem | undefined) {
  if (!item) return
  if (item.action === 'files') {
    closeAddMenu()
    pickFiles()
    return
  }
  if (item.action === 'insert_capability_token') {
    insertInlineToken(item.completion || item.label)
    closeAddMenu()
    closeModelMenu()
    closeModeMenu()
    return
  }
  if (!item.completion) return
  value.value = item.completion
  closeAddMenu()
  closeModelMenu()
  closeModeMenu()
  input.value?.focus()
  void nextTick(resize)
}

function insertInlineToken(token: string) {
  const insertion = token.trim()
  if (!insertion) return
  const el = input.value
  if (!el) {
    value.value = appendInlineToken(value.value, insertion)
    void nextTick(resize)
    return
  }
  const start = el.selectionStart ?? value.value.length
  const end = el.selectionEnd ?? start
  const before = value.value.slice(0, start)
  const after = value.value.slice(end)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  value.value = `${before}${prefix}${insertion}${suffix}${after}`
  const nextPos = before.length + prefix.length + insertion.length + suffix.length
  void nextTick(() => {
    input.value?.focus()
    input.value?.setSelectionRange(nextPos, nextPos)
    resize()
  })
}

function appendInlineToken(text: string, token: string) {
  const trimmed = text.trimEnd()
  return trimmed ? `${trimmed} ${token}` : token
}

async function toggleModeMenu() {
  if (props.busy) return
  closeAddMenu()
  closeModelMenu()
  if (modeMenuOpen.value) {
    closeModeMenu()
    return
  }
  modeMenuOpen.value = true
  modeFloatingMenu.addListeners()
  await nextTick()
  modeFloatingMenu.position()
}

function selectMode(mode: 'ask_before_edit' | 'auto' | 'plan') {
  if (props.busy) return
  closeModeMenu()
  if (mode !== props.controlMode) emit('set-mode', mode)
  input.value?.focus()
}

async function toggleModelMenu() {
  if (props.busy || !showModelSwitcher.value) return
  closeAddMenu()
  closeModeMenu()
  if (modelMenuOpen.value) {
    closeModelMenu()
    return
  }
  modelMenuOpen.value = true
  modelFloatingMenu.addListeners()
  await nextTick()
  modelFloatingMenu.position()
}

function selectModel(entryName: string) {
  if (props.busy) return
  closeModelMenu()
  if (entryName !== activeModelName.value) emit('switch-model', entryName)
  input.value?.focus()
}

function selectReasoning(value: string | null) {
  if (props.busy) return
  const next = normalizeReasoningValue(value) || null
  if ((currentReasoningValue.value || '') === (next || '')) return
  emit('set-reasoning-effort', next)
}

function toggleAddMenu() {
  if (props.busy) return
  closeModelMenu()
  closeModeMenu()
  if (addMenuOpen.value) {
    closeAddMenu()
    return
  }
  addMenuOpen.value = true
  document.addEventListener('pointerdown', onAddMenuPointerDown, true)
}

function closeAddMenu() {
  if (!addMenuOpen.value) return
  addMenuOpen.value = false
  document.removeEventListener('pointerdown', onAddMenuPointerDown, true)
}

function closeComposerMenus() {
  closeAddMenu()
  closeModelMenu()
  closeModeMenu()
}

function onAddMenuPointerDown(event: PointerEvent) {
  const target = event.target
  if (!(target instanceof Node)) return
  if (shell.value?.contains(target)) return
  closeAddMenu()
}

function closeModeMenu() {
  if (!modeMenuOpen.value) return
  modeMenuOpen.value = false
  modeFloatingMenu.removeListeners()
}

function closeModelMenu() {
  if (!modelMenuOpen.value) return
  modelMenuOpen.value = false
  modelFloatingMenu.removeListeners()
}

function pickFiles() {
  if (props.busy) return
  closeAddMenu()
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
  return 'currentColor'
})
const percentLabel = computed(() => `${Math.min(Math.round(pct.value * 100), 100)}%`)
const contextLabel = computed(() => `上下文长度 ${fmt(props.contextUsed)} / ${fmt(props.contextMax)}，已用 ${percentLabel.value}`)

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function modelEntryLabel(entry: ModelEntry) {
  return entry.label || entry.name
}

function entryMainModelId(entry: ModelEntry) {
  return entry.mainModelId || entry.id || '未配置'
}

function entrySecondaryModelId(entry: ModelEntry) {
  return entry.secondaryModelId || '未配置'
}

function normalizeReasoningValue(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return ''
  if (normalized === 'xhigh' || normalized === 'max') return 'max'
  if (['high', 'medium', 'low', 'none'].includes(normalized)) return normalized
  return normalized
}

function reasoningLabel(value?: string | null) {
  const normalized = normalizeReasoningValue(value)
  if (!normalized) return 'Default'
  if (normalized === 'max') return 'Max'
  if (normalized === 'high') return 'High'
  if (normalized === 'medium') return 'Medium'
  if (normalized === 'low') return 'Low'
  if (normalized === 'none') return 'None'
  return normalized
}

const sendDisabled = computed(() => composerSendDisabled({
  busy: props.busy,
  content: value.value,
  attachmentCount: drafts.value.length,
}))

onBeforeUnmount(() => {
  closeAddMenu()
  closeModelMenu()
  closeModeMenu()
})
</script>

<template>
  <div
    ref="shell"
    class="composer-shell"
    :class="{ 'composer-drag-active': dragActive }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <CapabilityPicker
      v-if="paletteMode"
      :groups="paletteGroups"
      :heading="paletteHeading"
      :hint="paletteHint"
      :mode="paletteMode"
      @select="applyPaletteItem"
    />

    <form class="composer" @submit.prevent="submit" @keydown.esc="closeComposerMenus">
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="ACCEPT_LIST"
        class="hidden-file-input"
        @change="onFileInput"
      />

      <div class="composer-input-row">
        <div
          class="composer-textarea-wrap"
          :class="{ 'has-skill-slash': composerSlashParts, 'has-inline-tokens': hasInlineTokens }"
        >
          <div
            v-if="composerSlashParts || hasInlineTokens"
            ref="highlightLayer"
            class="composer-highlight-layer"
            aria-hidden="true"
          >
            <template v-if="hasInlineTokens">
              <template v-for="(segment, index) in inlineSegments" :key="index">
                <span
                  v-if="segment.kind === 'token'"
                  class="composer-inline-token"
                  :data-kind="segment.tokenKind"
                >
                  {{ segment.tokenKind === 'skill' ? 'Skill' : 'MCP' }} · {{ segment.name }}
                </span>
                <span v-else>{{ segment.text }}</span>
              </template>
            </template>
            <template v-else-if="composerSlashParts">
              <span class="composer-skill-slash">{{ composerSlashParts.token }}</span><span>{{ composerSlashParts.rest }}</span>
            </template>
          </div>
          <textarea
            ref="input"
            v-model="value"
            rows="2"
            :disabled="props.busy"
            :placeholder="props.busy ? '正在生成回复...' : '描述要推进的任务。可用 / 调用命令，拖入图片或文档'"
            @focus="closeComposerMenus"
            @input="resize"
            @scroll="syncHighlightScroll"
            @keydown="handleKeydown"
          />
        </div>
      </div>

      <div v-if="drafts.length || uploading.size" class="composer-drafts composer-drafts-inline">
        <AttachmentChip
          v-for="(d, i) in drafts"
          :key="d.id"
          :data="d"
          removable
          @remove="removeDraft(i)"
        />
        <div v-for="name in Array.from(uploading)" :key="name" class="attach-chip uploading" :title="name">
          <span class="attach-doc-icon">
            <component :is="actionIcons.statusBusy" class="animate-spin" :size="14" />
          </span>
          <div class="attach-meta">
            <div class="attach-name">{{ name }}</div>
            <div class="attach-sub">上传中…</div>
          </div>
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
            @click="toggleAddMenu"
          >
            <component :is="actionIcons.new" class="action-icon" :size="16" />
          </button>
        </div>

        <div class="composer-right-actions">
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

          <div v-if="showModelSwitcher" class="model-picker">
            <button
              ref="modelButton"
              type="button"
              class="model-button"
              :aria-expanded="modelMenuOpen"
              :title="modelTitle"
              :disabled="props.busy"
              @click="toggleModelMenu"
            >
              <component :is="modelIcons.text" class="model-icon" :size="15" />
              <span class="model-button-label">{{ currentModelLabel }}</span>
              <span class="model-button-separator" aria-hidden="true">·</span>
              <span class="model-button-meta">{{ currentReasoningLabel }}</span>
              <component :is="actionIcons.caretDown" class="model-caret" :size="12" />
            </button>
          </div>

          <div class="mode-picker">
            <button
              ref="modeButton"
              type="button"
              class="mode-button"
              :data-active="currentMode.value === 'plan'"
              :aria-expanded="modeMenuOpen"
              :title="modeTitle"
              :disabled="props.busy"
              @click="toggleModeMenu"
            >
              <component :is="currentMode.icon" class="mode-icon" :size="16" />
              <span>{{ currentMode.short }}</span>
              <component :is="actionIcons.caretDown" class="mode-caret" :size="12" />
            </button>

          </div>

          <button
            class="send-button"
            :disabled="sendDisabled"
            :title="props.busy ? '停止当前任务' : '发送'"
            :type="props.busy ? 'button' : 'submit'"
            @click="props.busy ? emit('stop') : undefined"
          >
            <component :is="props.busy ? actionIcons.statusBusy : actionIcons.send" class="action-icon send-icon" :class="{ 'animate-spin': props.busy }" :size="18" />
            <span class="sr-only">{{ props.busy ? '停止' : '发送' }}</span>
          </button>
        </div>
      </div>
    </form>

    <Teleport to="body">
      <div
        v-if="modeMenuOpen"
        ref="modeMenu"
        class="mode-menu mode-menu-floating"
        :data-placement="modeMenuPlacement"
        :style="modeMenuStyle"
        @keydown.esc="closeModeMenu"
      >
        <div class="mode-menu-head">
          <span>执行方式</span>
          <em>立即应用到下一轮</em>
        </div>
        <button
          v-for="option in modeOptions"
          :key="option.value"
          type="button"
          class="mode-option"
          :data-active="currentMode.value === option.value"
          @click="selectMode(option.value)"
        >
          <component :is="option.icon" class="mode-option-icon" :size="16" />
          <span>
            <strong>{{ option.label }}</strong>
            <small>{{ option.description }}</small>
          </span>
          <b>{{ option.short }}</b>
        </button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="modelMenuOpen"
        ref="modelMenu"
        class="model-menu model-menu-floating"
        :data-placement="modelMenuPlacement"
        :style="modelMenuStyle"
        @keydown.esc="closeModelMenu"
      >
        <div class="model-menu-head">
          <span>模型与思考</span>
          <em>下一轮生效</em>
        </div>
        <div class="reasoning-row">
          <span>推理强度</span>
          <div class="reasoning-control" role="group" aria-label="推理强度">
            <button
              v-for="option in reasoningOptions"
              :key="option.label"
              type="button"
              class="reasoning-choice"
              :data-active="(option.value || '') === currentReasoningValue"
              :disabled="props.busy"
              @click="selectReasoning(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="model-menu-label">模型条目</div>
        <button
          v-for="entry in availableModelEntries"
          :key="entry.name"
          type="button"
          class="model-option"
          :data-active="entry.name === activeModelName"
          @click="selectModel(entry.name)"
        >
          <component :is="modelIcons.text" class="model-option-icon" :size="15" />
          <span class="model-option-copy">
            <strong>{{ modelEntryLabel(entry) }}</strong>
            <small>{{ entryMainModelId(entry) }}</small>
            <span class="model-option-meta">
              <em>{{ entry.provider || 'provider' }}</em>
              <em>次 {{ entrySecondaryModelId(entry) }}</em>
            </span>
          </span>
          <span class="model-option-badges">
            <b>{{ entry.name === activeModelName ? '当前' : '切换' }}</b>
          </span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
