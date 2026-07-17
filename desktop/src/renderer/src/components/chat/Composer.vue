<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { GoalCaptureStatus } from '../../composables/goalCapture'
import type { CapabilityPickerItem } from '../../capabilities/capabilityPicker'
import { buildCapabilityPickerGroups } from '../../capabilities/capabilityPickerModel'
import {
  hasComposerCapabilityTokens,
  normalizeComposerCapabilityInput,
  renderComposerInlineTokens,
} from '../../capabilities/composerCapabilityTokens'
import { isPathLikeSlashToken } from '../../commands'
import type { SlashPaletteItem } from '../../commands'
import type {
  ChatSendPayload,
  ControlPayload,
  CurrentModelConfig,
  ModelEntry,
  ProviderOption,
  RuntimeGoalSummary,
  ToolInfo,
} from '../../types'
import { actionIcons, toolIcon } from '../../icons'
import type { IconComponent } from '../../icons'
import {
  providerIconAsset,
  providerIconFallback,
  providerIconIsMonochrome,
  providerIconMaskCssUrl,
} from '../../model/providerIcons'
import { useAttachments } from '../../composables/useAttachments'
import AttachmentChip from './AttachmentChip.vue'
import CapabilityPicker from './CapabilityPicker.vue'
import ComposerLifecycleIndicator from './ComposerLifecycleIndicator.vue'
import {
  composerModeOptions,
  composerSendDisabled,
  composerStopPresentation,
  currentComposerPermission,
  type ControlModeValue,
} from './composerControls'
import { useFloatingMenu } from './floatingMenu'

const props = defineProps<{
  busy: boolean
  commands: SlashPaletteItem[]
  tools: ToolInfo[]
  mcpContent?: string
  contextUsed: number
  contextMax: number
  control?: ControlPayload | null
  currentModel?: CurrentModelConfig | null
  modelEntries: ModelEntry[]
  providerOptions: ProviderOption[]
  supportsVision?: boolean
  sendBlockedReason?: string | null
  goal?: RuntimeGoalSummary | null
  goalCaptureStatus?: GoalCaptureStatus
}>()
const emit = defineEmits<{
  send: [payload: ChatSendPayload]
  stop: []
  error: [message: string]
  'set-permission': [mode: ControlModeValue]
  'switch-model': [entryId: string]
  'set-reasoning-effort': [level: string | null]
  'activate-plan': []
  'activate-goal': []
  'exit-plan': []
  'cancel-goal': []
  'start-goal': [outcome: string]
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
const {
  drafts,
  uploading,
  dragActive,
  onFileInput,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  removeDraft,
  takeDrafts,
} = useAttachments({
  isBusy: () => props.busy,
  onError: (message) => emit('error', message),
})
const addMenuOpen = ref(false)
const modelMenuOpen = ref(false)
const modeMenuOpen = ref(false)
const modelFloatingMenu = useFloatingMenu({
  open: modelMenuOpen,
  button: modelButton,
  menu: modelMenu,
  fallbackWidth: 390,
  fallbackHeight: 420,
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

const suggestions = computed(() => {
  const text = value.value
  if (!text.startsWith('/')) return []
  if (/^\/\S+\s/.test(text)) return []
  const query = text.slice(1).split(/\s+/, 1)[0].toLowerCase()
  return props.commands.filter((item) => {
    if (!query) return true
    const haystack = [
      item.name,
      item.usage,
      item.description,
      item.tags || '',
      ...(item.aliases || []),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(query)
  })
})
const commandSuggestions = computed(() =>
  suggestions.value.filter((item) => item.kind === 'command'),
)
const skillSuggestions = computed(() =>
  suggestions.value.filter((item) => item.kind === 'skill'),
)
const slashPaletteGroups = computed(() =>
  [
    {
      label: '命令',
      items: commandSuggestions.value.map((item) =>
        paletteItemFromSlash(item, '命令'),
      ),
    },
    {
      label: 'Skills',
      items: skillSuggestions.value.map((item) =>
        paletteItemFromSlash(item, 'Skill'),
      ),
    },
  ].filter((group) => group.items.length),
)
const addPaletteGroups = computed(() =>
  buildCapabilityPickerGroups({
    commands: props.commands,
    tools: props.tools,
    mcpContent: props.mcpContent || '',
  }),
)
const paletteMode = computed<'add' | 'slash' | null>(() => {
  if (addMenuOpen.value) return 'add'
  if (slashPaletteGroups.value.length) return 'slash'
  return null
})
const paletteGroups = computed(() =>
  paletteMode.value === 'add'
    ? addPaletteGroups.value
    : slashPaletteGroups.value,
)
const paletteHeading = computed(() =>
  paletteMode.value === 'add' ? '添加能力' : '斜杠命令',
)
const paletteHint = computed(() =>
  paletteMode.value === 'add'
    ? '插入附件、Skill 或 MCP 占位符'
    : 'Tab 补全第一项',
)
const inlineSegments = computed(() => renderComposerInlineTokens(value.value))
const hasInlineTokens = computed(() => hasComposerCapabilityTokens(value.value))
const composerSlashParts = computed(
  (): { token: string; rest: string } | null => {
    const text = value.value
    if (!text.startsWith('/')) return null
    const token = text.match(/^\/\S+/)?.[0]
    if (!token || token === '/') return null
    if (isPathLikeSlashToken(token)) return null
    const normalized = token.toLowerCase()
    const isSystemCommand = props.commands.some(
      (item) =>
        item.kind === 'command' &&
        (item.name === normalized || item.aliases?.includes(normalized)),
    )
    if (isSystemCommand) return null
    return { token, rest: text.slice(token.length) }
  },
)

const attachTitle = computed(() =>
  props.busy ? '等待当前任务结束后再添加' : 'Add files and more',
)

const modeOptions = composerModeOptions.map((option) => ({
  ...option,
  icon:
    option.value === 'ask_before_edit'
      ? actionIcons.modeAskBeforeEdit
      : option.value === 'accept_edits'
        ? actionIcons.modeAcceptEdits
        : actionIcons.modeAuto,
}))

const currentMode = computed(() => {
  const option = currentComposerPermission(props.control)
  return (
    modeOptions.find((item) => item.value === option.value) || modeOptions[0]
  )
})
const modeTitle = computed(() =>
  props.busy ? '等待当前任务结束后再切换' : '切换执行权限',
)
const planActive = computed(() => props.control?.mode === 'plan')
const goalCaptureActive = computed(
  () =>
    props.goalCaptureStatus === 'armed' ||
    props.goalCaptureStatus === 'starting',
)
const goalCaptureStarting = computed(
  () => props.goalCaptureStatus === 'starting',
)
const goalActive = computed(
  () => Boolean(props.goal) || goalCaptureActive.value,
)
const availableModelEntries = computed(() =>
  props.modelEntries.filter((entry) => entry.entryId),
)
const activeModelId = computed(
  () => props.currentModel?.entryId || props.modelEntries[0]?.entryId || '',
)
const currentModelEntry = computed(
  () =>
    availableModelEntries.value.find(
      (entry) => entry.entryId === activeModelId.value,
    ) ||
    availableModelEntries.value[0] ||
    null,
)
const otherModelEntries = computed(() =>
  availableModelEntries.value.filter(
    (entry) => entry.entryId !== activeModelId.value,
  ),
)
const showModelSwitcher = computed(() => availableModelEntries.value.length > 0)
const currentModelLabel = computed(() => {
  const entry = currentModelEntry.value
  if (entry) return entry.displayName || entry.modelId || '模型'
  return (
    props.currentModel?.displayName || props.currentModel?.modelId || '模型'
  )
})
const currentProviderName = computed(
  () => currentModelEntry.value?.provider || props.currentModel?.provider || '',
)
const currentProviderLabel = computed(() =>
  providerLabel(currentProviderName.value),
)
const currentProviderIconId = computed(
  () =>
    providerOption(currentProviderName.value)?.iconId ||
    currentProviderName.value,
)
const currentProviderIcon = computed(() =>
  providerIconAsset(currentProviderIconId.value),
)
const currentProviderIconMonochrome = computed(() =>
  providerIconIsMonochrome(currentProviderIconId.value),
)
const currentProviderMaskStyle = computed((): Record<string, string> => {
  if (!currentProviderIcon.value) return {}
  return {
    '--provider-icon': providerIconMaskCssUrl(currentProviderIcon.value),
  }
})
const currentProviderFallback = computed(() =>
  providerIconFallback(currentProviderLabel.value),
)
const currentModelId = computed(
  () => currentModelEntry.value?.modelId || props.currentModel?.modelId || '',
)
const currentProtocolLabel = computed(() =>
  protocolLabel(
    currentModelEntry.value?.protocol ||
      props.currentModel?.protocol ||
      'openai',
  ),
)
const currentReasoningLabel = computed(() =>
  reasoningLabel(
    props.currentModel?.reasoningEffort ??
      currentModelEntry.value?.reasoningEffort ??
      null,
  ),
)
const currentReasoningValue = computed(() =>
  normalizeReasoningValue(
    props.currentModel?.reasoningEffort ??
      currentModelEntry.value?.reasoningEffort ??
      null,
  ),
)
const modelTitle = computed(() => {
  if (props.busy) return '等待当前任务结束后再切换模型'
  return `${currentModelLabel.value} · 思考 ${currentReasoningLabel.value}`
})
const reasoningOptions = computed(() => [
  { value: null, label: 'Default' },
  ...(props.currentModel?.reasoningEfforts || []).map((value) => ({
    value,
    label: reasoningLabel(value),
  })),
])

function paletteItemFromSlash(
  item: SlashPaletteItem,
  meta: string,
): CapabilityPickerItem {
  const skillName = item.skillName || item.name.replace(/^\//, '')
  return {
    id: item.id,
    action:
      item.kind === 'skill'
        ? 'insert_capability_token'
        : item.name === '/plan'
          ? 'activate_plan'
          : item.name === '/goal'
            ? 'activate_goal'
            : 'insert_command',
    label: item.name,
    description: item.description,
    meta: item.kind === 'skill' ? item.tags || meta : item.usage,
    completion:
      item.kind === 'skill' ? `@skill(${skillName})` : item.completion,
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
  if (props.busy || goalCaptureStarting.value) return
  if (props.sendBlockedReason) {
    emit('error', props.sendBlockedReason)
    return
  }
  const normalized = normalizeComposerCapabilityInput(value.value.trim())
  const content = normalized.content.trim()
  if (goalCaptureActive.value) {
    if (
      drafts.value.length > 0 ||
      uploading.value.size > 0 ||
      normalized.requestedSkills.length > 0 ||
      hasInlineTokens.value
    ) {
      emit(
        'error',
        'Goal Outcome 暂仅支持纯文字；请先移除附件、Skill 或 MCP 引用。',
      )
      return
    }
    if (!content) return
    emit('start-goal', content)
    closeComposerMenus()
    return
  }
  if (!content && drafts.value.length === 0) return
  emit('send', {
    content,
    attachments: takeDrafts(),
    requestedSkills: normalized.requestedSkills,
    displayContent: normalized.displayContent,
  })
  value.value = ''
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
  if (item.action === 'activate_plan' || item.action === 'activate_goal') {
    const fromSlashPalette = paletteMode.value === 'slash'
    if (fromSlashPalette) value.value = ''
    closeAddMenu()
    closeModelMenu()
    closeModeMenu()
    if (item.action === 'activate_plan') emit('activate-plan')
    else emit('activate-goal')
    input.value?.focus()
    void nextTick(resize)
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
  const nextPos =
    before.length + prefix.length + insertion.length + suffix.length
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

function selectMode(mode: ControlModeValue) {
  if (props.busy) return
  closeModeMenu()
  if (mode !== currentMode.value?.value) emit('set-permission', mode)
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
  focusModelMenuItem(0)
}

function modelMenuItems(): HTMLButtonElement[] {
  if (!modelMenu.value) return []
  return Array.from(
    modelMenu.value.querySelectorAll<HTMLButtonElement>(
      'button:not(:disabled)',
    ),
  )
}

function focusModelMenuItem(index: number): void {
  const items = modelMenuItems()
  if (!items.length) return
  items[((index % items.length) + items.length) % items.length]?.focus()
}

function onModelMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeModelMenu()
    modelButton.value?.focus()
    return
  }
  if (
    event.key !== 'ArrowDown' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'Home' &&
    event.key !== 'End' &&
    event.key !== 'Tab'
  )
    return
  const items = modelMenuItems()
  if (!items.length) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'Home') focusModelMenuItem(0)
  else if (event.key === 'End') focusModelMenuItem(items.length - 1)
  else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey))
    focusModelMenuItem(current <= 0 ? items.length - 1 : current - 1)
  else focusModelMenuItem(current < 0 ? 0 : current + 1)
}

function selectModel(entryId: string) {
  if (props.busy) return
  closeModelMenu()
  if (entryId !== activeModelId.value) emit('switch-model', entryId)
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

const pct = computed(() =>
  props.contextMax > 0 ? props.contextUsed / props.contextMax : 0,
)
const arcLength = computed(() => Math.min(Math.round(pct.value * 100), 100))
const arcColor = computed(() => {
  return 'currentColor'
})
const percentLabel = computed(
  () => `${Math.min(Math.round(pct.value * 100), 100)}%`,
)
const contextLabel = computed(
  () =>
    `上下文长度 ${fmt(props.contextUsed)} / ${fmt(props.contextMax)}，已用 ${percentLabel.value}`,
)

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function modelEntryLabel(entry: ModelEntry) {
  return entry.displayName || entry.modelId || '模型'
}

function providerOption(name: string): ProviderOption | undefined {
  return props.providerOptions.find((option) => option.name === name)
}

function providerLabel(name: string): string {
  const option = providerOption(name)
  return option?.displayName || option?.name || name || 'Provider'
}

function providerIcon(entry: ModelEntry): string | null {
  return providerIconAsset(
    providerOption(entry.provider)?.iconId || entry.provider,
  )
}

function providerFallback(entry: ModelEntry): string {
  return providerIconFallback(providerLabel(entry.provider))
}

function protocolLabel(protocol: 'openai' | 'anthropic'): string {
  return protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'
}

function normalizeReasoningValue(value?: string | null) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (!normalized) return ''
  if (
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
      normalized,
    )
  )
    return normalized
  return normalized
}

function reasoningLabel(value?: string | null) {
  const normalized = normalizeReasoningValue(value)
  if (!normalized) return 'Default'
  if (normalized === 'max') return 'Max'
  if (normalized === 'xhigh') return 'XHigh'
  if (normalized === 'high') return 'High'
  if (normalized === 'medium') return 'Medium'
  if (normalized === 'low') return 'Low'
  if (normalized === 'minimal') return 'Minimal'
  if (normalized === 'none') return 'None'
  return normalized
}

const sendDisabled = computed(
  () =>
    goalCaptureStarting.value ||
    composerSendDisabled({
      busy: props.busy,
      content: value.value,
      attachmentCount: drafts.value.length,
      sendBlockedReason: props.sendBlockedReason || null,
    }),
)
const stopPresentation = computed(() =>
  composerStopPresentation(Boolean(props.goal)),
)

watch(
  () => props.goalCaptureStatus,
  (status, previous) => {
    if (previous !== 'starting' || status !== 'idle') return
    value.value = ''
    void nextTick(resize)
  },
)

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

    <form
      class="composer"
      @submit.prevent="submit"
      @keydown.esc="closeComposerMenus"
    >
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
          :class="{
            'has-skill-slash': composerSlashParts,
            'has-inline-tokens': hasInlineTokens,
          }"
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
                  {{ segment.tokenKind === 'skill' ? 'Skill' : 'MCP' }} ·
                  {{ segment.name }}
                </span>
                <span v-else>{{ segment.text }}</span>
              </template>
            </template>
            <template v-else-if="composerSlashParts">
              <span class="composer-skill-slash">{{
                composerSlashParts.token
              }}</span
              ><span>{{ composerSlashParts.rest }}</span>
            </template>
          </div>
          <textarea
            ref="input"
            v-model="value"
            rows="2"
            :disabled="props.busy || goalCaptureStarting"
            :placeholder="
              props.busy
                ? '正在生成回复...'
                : goalCaptureStarting
                  ? '正在启动 Goal...'
                  : goalCaptureActive
                    ? '描述要持续完成的目标'
                    : props.sendBlockedReason ||
                      '描述要推进的任务。可用 / 调用命令，拖入图片或文档'
            "
            @focus="closeComposerMenus"
            @input="resize"
            @scroll="syncHighlightScroll"
            @keydown="handleKeydown"
          />
        </div>
      </div>

      <div
        v-if="drafts.length || uploading.size"
        class="composer-drafts composer-drafts-inline"
      >
        <AttachmentChip
          v-for="(d, i) in drafts"
          :key="d.id"
          :data="d"
          removable
          @remove="removeDraft(i)"
        />
        <div
          v-for="name in Array.from(uploading)"
          :key="name"
          class="attach-chip uploading"
          :title="name"
        >
          <span class="attach-doc-icon">
            <component
              :is="actionIcons.statusBusy"
              class="animate-spin"
              :size="14"
            />
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
            :disabled="props.busy || goalCaptureStarting"
            @click="toggleAddMenu"
          >
            <component :is="actionIcons.new" class="action-icon" :size="16" />
          </button>

          <div class="mode-picker">
            <button
              ref="modeButton"
              type="button"
              class="mode-button"
              :aria-expanded="modeMenuOpen"
              :title="modeTitle"
              :disabled="props.busy"
              @click="toggleModeMenu"
            >
              <component :is="currentMode.icon" class="mode-icon" :size="16" />
              <span>{{ currentMode.short }}</span>
              <component
                :is="actionIcons.caretDown"
                class="mode-caret"
                :size="12"
              />
            </button>
          </div>

          <span
            v-if="goalActive || planActive"
            class="composer-action-divider"
            aria-hidden="true"
          />
          <ComposerLifecycleIndicator
            v-if="goalActive"
            kind="goal"
            :busy="props.busy || goalCaptureStarting"
            @dismiss="emit('cancel-goal')"
          />
          <ComposerLifecycleIndicator
            v-if="planActive"
            kind="plan"
            :busy="props.busy || goalCaptureStarting"
            @dismiss="emit('exit-plan')"
          />
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
                cx="18"
                cy="18"
                r="15.915"
                :stroke="arcColor"
                :stroke-dasharray="`${arcLength} ${100 - arcLength}`"
                stroke-dashoffset="25"
              />
            </svg>
            <div class="context-tooltip" role="tooltip">
              <strong>上下文长度</strong>
              <span
                >{{ fmt(props.contextUsed) }} /
                {{ fmt(props.contextMax) }}</span
              >
              <em>已用 {{ percentLabel }}</em>
            </div>
          </div>

          <div v-if="showModelSwitcher" class="model-picker">
            <button
              ref="modelButton"
              type="button"
              class="model-button"
              aria-controls="composer-model-menu"
              :aria-expanded="modelMenuOpen"
              :title="modelTitle"
              :disabled="props.busy"
              @click="toggleModelMenu"
            >
              <span
                class="model-provider-avatar bare compact"
                aria-hidden="true"
              >
                <span
                  v-if="currentProviderIcon && currentProviderIconMonochrome"
                  class="model-provider-mask"
                  :style="currentProviderMaskStyle"
                />
                <img
                  v-else-if="currentProviderIcon"
                  :src="currentProviderIcon"
                  alt=""
                />
                <span v-else>{{ currentProviderFallback }}</span>
              </span>
              <span class="model-button-label">{{ currentModelLabel }}</span>
              <component
                :is="actionIcons.caretDown"
                class="model-caret"
                :size="12"
              />
            </button>
          </div>

          <button
            class="send-button"
            :disabled="sendDisabled"
            :title="
              props.busy
                ? stopPresentation.title
                : goalCaptureStarting
                  ? '正在启动 Goal'
                  : props.sendBlockedReason || '发送'
            "
            :aria-label="
              props.busy
                ? stopPresentation.label
                : goalCaptureStarting
                  ? '正在启动 Goal'
                  : '发送'
            "
            :type="props.busy ? 'button' : 'submit'"
            @click="props.busy ? emit('stop') : undefined"
          >
            <component
              :is="
                props.busy || goalCaptureStarting
                  ? actionIcons.statusBusy
                  : actionIcons.send
              "
              class="action-icon send-icon"
              :class="{ 'animate-spin': props.busy || goalCaptureStarting }"
              :size="18"
            />
            <span class="sr-only">{{
              props.busy
                ? stopPresentation.label
                : goalCaptureStarting
                  ? '正在启动 Goal'
                  : '发送'
            }}</span>
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
          <span>执行权限</span>
          <em>{{ planActive ? 'Plan 结束后使用' : '立即应用到下一轮' }}</em>
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
        id="composer-model-menu"
        ref="modelMenu"
        class="model-menu model-menu-floating"
        role="dialog"
        aria-label="模型与思考"
        :data-placement="modelMenuPlacement"
        :style="modelMenuStyle"
        @keydown="onModelMenuKeydown"
      >
        <div class="model-menu-head">
          <span>模型</span>
          <em>下一轮生效</em>
        </div>
        <div class="model-current-card">
          <span class="model-provider-avatar" aria-hidden="true">
            <img v-if="currentProviderIcon" :src="currentProviderIcon" alt="" />
            <span v-else>{{ currentProviderFallback }}</span>
          </span>
          <span class="model-current-copy">
            <small>当前模型</small>
            <strong>{{ currentModelLabel }}</strong>
            <code>{{ currentModelId || '未配置模型 ID' }}</code>
            <span>
              {{ currentProviderLabel }} · {{ currentProtocolLabel }} · 思考
              {{ currentReasoningLabel }}
            </span>
          </span>
        </div>
        <div v-if="reasoningOptions.length > 1" class="reasoning-row">
          <span>思考强度</span>
          <div class="reasoning-control" role="group" aria-label="思考强度">
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

        <div class="model-menu-label">其他模型</div>
        <button
          v-for="entry in otherModelEntries"
          :key="entry.entryId"
          type="button"
          class="model-option"
          @click="entry.entryId && selectModel(entry.entryId)"
        >
          <span class="model-provider-avatar compact" aria-hidden="true">
            <img
              v-if="providerIcon(entry)"
              :src="providerIcon(entry) || ''"
              alt=""
            />
            <span v-else>{{ providerFallback(entry) }}</span>
          </span>
          <span class="model-option-copy">
            <strong>{{ modelEntryLabel(entry) }}</strong>
            <small>{{ entry.modelId || '未配置' }}</small>
            <span class="model-option-meta">
              <em>{{ providerLabel(entry.provider) }}</em>
              <em>{{ protocolLabel(entry.protocol) }}</em>
            </span>
          </span>
          <span class="model-option-badges">
            <b>切换</b>
          </span>
        </button>
        <p v-if="!otherModelEntries.length" class="model-menu-empty">
          没有其他已保存模型。
        </p>
      </div>
    </Teleport>
  </div>
</template>
