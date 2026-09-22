import type { CommandCompletion } from '@emperor/core/api'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { CapabilityPickerItem } from '../../capabilities/capabilityPicker'
import { buildCapabilityPickerGroups } from '../../capabilities/capabilityPickerModel'
import {
  hasComposerCapabilityTokens,
  normalizeComposerCapabilityInput,
  renderComposerInlineTokens,
} from '../../capabilities/composerCapabilityTokens'
import {
  buildSlashPaletteGroups,
  isPathLikeSlashToken,
  rankSlashPaletteItems,
} from '../../commands'
import type { SlashPaletteItem } from '../../commands'
import type { GoalCaptureStatus } from '../../composables/goalCapture'
import type { ComposerLifecycleMode } from '../../composables/composerLifecycle'
import { useAttachments } from '../../composables/useAttachments'
import { actionIcons, toolIcon, type IconComponent } from '../../icons'
import {
  providerIconAsset,
  providerIconFallback,
  providerIconIsMonochrome,
  providerIconMaskCssUrl,
} from '../../model/providerIcons'
import type {
  ChatSendPayload,
  ControlPayload,
  CurrentModelConfig,
  ModelEntry,
  ProviderOption,
  RuntimeGoalView,
  ToolInfo,
} from '../../types'
import {
  composerPresetOptions,
  composerSendDisabled,
  composerStopPresentation,
  currentComposerPermission,
  type ControlModeValue,
} from './composerControls'
import { useFloatingMenu } from './floatingMenu'

export interface ComposerControllerProps {
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
  goal?: RuntimeGoalView | null
  planPaused?: boolean
  goalCaptureStatus?: GoalCaptureStatus
  lifecycleMode?: ComposerLifecycleMode
  interactionBlocked?: boolean
  queueOccupied?: boolean
  completeCommand?: (
    commandId: string,
    rawArgs: string,
    cursor: number,
  ) => Promise<CommandCompletion[]>
  refreshCommands?: () => Promise<void>
}

export interface ComposerEmit {
  (event: 'send', payload: ChatSendPayload): void
  (event: 'stop'): void
  (event: 'error', message: string): void
  (event: 'set-permission', mode: ControlModeValue): void
  (event: 'switch-model', entryId: string): void
  (event: 'set-reasoning-effort', level: string | null): void
  (event: 'activate-plan'): void
  (event: 'activate-goal'): void
  (event: 'dismiss-lifecycle'): void
  (event: 'start-goal', outcome: string): void
}

export const COMPOSER_ACCEPT_LIST =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,application/json,text/csv,text/plain,text/markdown'
/** dsh draft cap: 14 lines × 24px (the takeover bodies share it). */
export const COMPOSER_TEXT_MAX_HEIGHT = 336
export const COMPOSER_QUEUE_FULL_MESSAGE =
  '已有一条消息排队，请先编辑、插入或删除后再发送。'

export function useComposerController(
  props: Readonly<ComposerControllerProps>,
  emit: ComposerEmit,
) {
  const value = ref('')
  const shell = ref<HTMLElement | null>(null)
  const input = ref<HTMLTextAreaElement | null>(null)
  const highlightLayer = ref<HTMLElement | null>(null)
  const fileInput = ref<HTMLInputElement | null>(null)
  const modelButton = ref<HTMLButtonElement | null>(null)
  const modelMenu = ref<HTMLElement | null>(null)
  const modeButton = ref<HTMLButtonElement | null>(null)
  const modeMenu = ref<HTMLElement | null>(null)
  const attachments = useAttachments({
    onError: (message) => emit('error', message),
  })
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
    restoreDrafts,
  } = attachments

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

  const argumentCompletions = ref<CommandCompletion[]>([])
  const paletteSelectionIndex = ref(0)
  const dismissedSlashInput = ref('')
  let completionGeneration = 0

  const suggestions = computed(() => {
    const text = value.value
    if (!text.startsWith('/')) return []
    if (dismissedSlashInput.value === text) return []
    if (/^\/\S+\s/.test(text)) return []
    return rankSlashPaletteItems(
      props.commands,
      text.slice(1).split(/\s+/, 1)[0]!.toLowerCase(),
    )
  })
  const commandSuggestions = computed(() =>
    suggestions.value.filter((item) => item.kind === 'command'),
  )
  const skillSuggestions = computed(() =>
    suggestions.value.filter((item) => item.kind === 'skill'),
  )
  const exactComposerCommand = computed(() => {
    const token = value.value.match(/^\/\S+/)?.[0]?.toLowerCase()
    if (!token) return null
    return (
      props.commands.find(
        (item) =>
          item.name.toLowerCase() === token ||
          item.aliases?.some((alias) => alias.toLowerCase() === token),
      ) ?? null
    )
  })
  const slashPaletteGroups = computed(() => {
    if (argumentCompletions.value.length) {
      const command = exactComposerCommand.value
      if (!command) return []
      return [
        {
          label: command.title,
          items: argumentCompletions.value.map((item, index) => ({
            id: `completion:${command.commandId}:${index}`,
            action: 'insert_command' as const,
            label: item.label,
            description: item.description || command.description,
            meta: item.kind || '参数',
            completion: `${command.name} ${item.value}`,
            icon: commandIcon(command.name),
            tone: 'slate' as const,
          })),
        },
      ]
    }
    return buildSlashPaletteGroups(
      [...commandSuggestions.value, ...skillSuggestions.value],
      {
        busy: props.busy,
        canContinue:
          props.goal?.phase === 'paused' || Boolean(props.planPaused),
      },
    ).map(({ label, items }) => ({
      label,
      items: items.map((item) => paletteItemFromSlash(item, label)),
    }))
  })
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
  const flatPaletteItems = computed(() =>
    paletteGroups.value.flatMap((group) => group.items),
  )
  const activePaletteItem = computed(() => {
    if (!flatPaletteItems.value.length) return undefined
    return flatPaletteItems.value[
      Math.min(paletteSelectionIndex.value, flatPaletteItems.value.length - 1)
    ]
  })
  const paletteHeading = computed(() =>
    paletteMode.value === 'add' ? '添加能力' : '斜杠命令',
  )
  const paletteHint = computed(() =>
    paletteMode.value === 'add'
      ? '插入附件、Skill 或 MCP 占位符'
      : 'Tab 补全第一项',
  )

  watch(paletteMode, (current, previous) => {
    if (current === 'slash' && previous !== 'slash')
      void props.refreshCommands?.()
  })
  const inlineSegments = computed(() => renderComposerInlineTokens(value.value))
  const hasInlineTokens = computed(() =>
    hasComposerCapabilityTokens(value.value),
  )
  const composerSlashParts = computed(() => {
    const text = value.value
    if (!text.startsWith('/')) return null
    const token = text.match(/^\/\S+/)?.[0]
    if (!token || token === '/' || isPathLikeSlashToken(token)) return null
    const normalized = token.toLowerCase()
    const matched = props.commands.find(
      (item) =>
        item.name.toLowerCase() === normalized ||
        item.aliases?.some((alias) => alias.toLowerCase() === normalized),
    )
    if (matched?.kind !== 'skill') return null
    return { token, rest: text.slice(token.length) }
  })

  watch(value, async (text) => {
    if (dismissedSlashInput.value && dismissedSlashInput.value !== text)
      dismissedSlashInput.value = ''
    paletteSelectionIndex.value = 0
    const generation = ++completionGeneration
    argumentCompletions.value = []
    const command = exactComposerCommand.value
    const token = text.match(/^\/\S+/)?.[0] || ''
    if (!command || !props.completeCommand || !/^\/\S+\s/.test(text)) return
    try {
      const rawArgs = text.slice(token.length).trimStart()
      const completions = await props.completeCommand(
        command.commandId,
        rawArgs,
        rawArgs.length,
      )
      if (generation === completionGeneration)
        argumentCompletions.value = completions
    } catch {
      if (generation === completionGeneration) argumentCompletions.value = []
    }
  })

  const modeOptions = computed(() =>
    composerPresetOptions(props.control).map((option) => ({
      ...option,
      icon:
        option.value === 'read-only'
          ? actionIcons.modeAskBeforeEdit
          : option.value === 'workspace-write'
            ? actionIcons.modeAcceptEdits
            : actionIcons.modeAuto,
    })),
  )
  const currentMode = computed(() => {
    const option = currentComposerPermission(props.control)
    return (
      modeOptions.value.find((item) => item.value === option.value) ??
      modeOptions.value[1]!
    )
  })
  const modeTitle = computed(() =>
    props.busy ? '等待当前任务结束后再切换' : '切换执行权限',
  )
  const permissionAppliesAfterPlan = computed(
    () => props.control?.plan === true,
  )
  const goalCaptureActive = computed(
    () =>
      props.goalCaptureStatus === 'armed' ||
      props.goalCaptureStatus === 'starting',
  )
  const goalCaptureStarting = computed(
    () => props.goalCaptureStatus === 'starting',
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
      ) ??
      availableModelEntries.value[0] ??
      null,
  )
  const otherModelEntries = computed(() =>
    availableModelEntries.value.filter(
      (entry) => entry.entryId !== activeModelId.value,
    ),
  )
  const showModelSwitcher = computed(
    () => availableModelEntries.value.length > 0,
  )
  const currentModelLabel = computed(
    () =>
      currentModelEntry.value?.effectiveDisplayName ||
      currentModelEntry.value?.modelId ||
      props.currentModel?.effectiveDisplayName ||
      props.currentModel?.modelId ||
      '模型',
  )
  const currentProviderName = computed(
    () =>
      currentModelEntry.value?.provider || props.currentModel?.provider || '',
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
  const currentProviderMaskStyle = computed((): Record<string, string> =>
    currentProviderIcon.value
      ? { '--provider-icon': providerIconMaskCssUrl(currentProviderIcon.value) }
      : {},
  )
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
  const currentReasoningValue = computed(() =>
    normalizeReasoningValue(
      props.currentModel?.reasoningEffort ??
        currentModelEntry.value?.reasoningEffort ??
        null,
    ),
  )
  const currentReasoningLabel = computed(() =>
    reasoningLabel(currentReasoningValue.value),
  )
  const modelTitle = computed(() =>
    props.busy
      ? '等待当前任务结束后再切换模型'
      : `${currentModelLabel.value} · 思考 ${currentReasoningLabel.value}`,
  )
  const reasoningOptions = computed(() => [
    { value: null, label: 'Default' },
    ...(props.currentModel?.reasoningEfforts || []).map((option) => ({
      value: option,
      label: reasoningLabel(option),
    })),
  ])

  const pct = computed(() =>
    props.contextMax > 0 ? props.contextUsed / props.contextMax : 0,
  )
  const arcLength = computed(() => Math.min(Math.round(pct.value * 100), 100))
  const arcColor = computed(() => 'currentColor')
  const percentLabel = computed(
    () => `${Math.min(Math.round(pct.value * 100), 100)}%`,
  )
  const contextLabel = computed(
    () =>
      `上下文长度 ${fmt(props.contextUsed)} / ${fmt(props.contextMax)}，已用 ${percentLabel.value}`,
  )
  const sendDisabled = computed(
    () =>
      goalCaptureStarting.value ||
      props.interactionBlocked ||
      composerSendDisabled({
        busy: props.busy,
        content: value.value,
        attachmentCount: drafts.value.length,
        queueOccupied: props.queueOccupied,
        sendBlockedReason: props.sendBlockedReason || null,
      }),
  )
  const stopPresentation = computed(() =>
    composerStopPresentation(Boolean(props.goal)),
  )

  function resize(): void {
    const element = input.value
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_TEXT_MAX_HEIGHT)}px`
    syncHighlightScroll()
  }

  function syncHighlightScroll(): void {
    if (!input.value || !highlightLayer.value) return
    highlightLayer.value.scrollTop = input.value.scrollTop
  }

  function submit(delivery?: 'queue' | 'interject'): void {
    if (goalCaptureStarting.value) return
    if (props.sendBlockedReason) {
      emit('error', props.sendBlockedReason)
      return
    }
    const normalized = normalizeComposerCapabilityInput(value.value.trim())
    const content = normalized.content.trim()
    if (props.busy) {
      if (!content && drafts.value.length === 0) return
      if (props.queueOccupied) {
        emit('error', COMPOSER_QUEUE_FULL_MESSAGE)
        return
      }
      if (uploading.value.size > 0) {
        emit('error', '附件仍在处理中，请等待完成后再排队。')
        return
      }
      emit('send', {
        content,
        attachments: takeDrafts(),
        requestedSkills: normalized.requestedSkills,
        displayContent: normalized.displayContent,
        delivery: delivery || 'queue',
      })
      value.value = ''
      closeComposerMenus()
      void nextTick(resize)
      return
    }
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
    closeComposerMenus()
    void nextTick(resize)
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      flatPaletteItems.value.length
    ) {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      paletteSelectionIndex.value =
        (paletteSelectionIndex.value + delta + flatPaletteItems.value.length) %
        flatPaletteItems.value.length
      return
    }
    if (event.key === 'Escape' && paletteMode.value === 'slash') {
      event.preventDefault()
      dismissedSlashInput.value = value.value
      return
    }
    if (event.key === 'Tab' && activePaletteItem.value) {
      event.preventDefault()
      applyPaletteItem(activePaletteItem.value)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    const exact = exactComposerCommand.value
    const token = value.value.match(/^\/\S+/)?.[0] || ''
    if (
      activePaletteItem.value &&
      (!exact ||
        paletteSelectionIndex.value > 0 ||
        argumentCompletions.value.length > 0)
    ) {
      applyPaletteItem(activePaletteItem.value)
      return
    }
    if (
      exact?.requiresArguments &&
      value.value.trim().toLowerCase() === token.toLowerCase()
    ) {
      value.value = `${token} `
      void nextTick(resize)
      return
    }
    submit()
  }

  function setDraft(text: string): void {
    value.value = text
    void nextTick(() => {
      resize()
      input.value?.focus()
    })
  }

  function focusInput(): void {
    input.value?.focus()
  }

  function restoreDraft(payload: ChatSendPayload): void {
    value.value = String(payload.displayContent || payload.content || '')
    restoreDrafts(payload.attachments || [])
    void nextTick(() => {
      resize()
      input.value?.focus()
    })
  }

  function applyPaletteItem(item: CapabilityPickerItem | undefined): void {
    if (!item) return
    if (item.action === 'files') {
      closeAddMenu()
      pickFiles()
      return
    }
    if (item.action === 'insert_capability_token') {
      insertInlineToken(item.completion || item.label)
      closeComposerMenus()
      return
    }
    if (item.action === 'activate_plan' || item.action === 'activate_goal') {
      if (paletteMode.value === 'slash') value.value = ''
      closeComposerMenus()
      if (item.action === 'activate_plan') emit('activate-plan')
      else emit('activate-goal')
      input.value?.focus()
      void nextTick(resize)
      return
    }
    if (!item.completion) return
    value.value = item.completion
    paletteSelectionIndex.value = 0
    dismissedSlashInput.value = ''
    closeComposerMenus()
    input.value?.focus()
    void nextTick(resize)
  }

  function insertInlineToken(token: string): void {
    const insertion = token.trim()
    if (!insertion) return
    const element = input.value
    if (!element) {
      value.value = appendInlineToken(value.value, insertion)
      void nextTick(resize)
      return
    }
    const start = element.selectionStart ?? value.value.length
    const end = element.selectionEnd ?? start
    const before = value.value.slice(0, start)
    const after = value.value.slice(end)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    value.value = `${before}${prefix}${insertion}${suffix}${after}`
    const nextPosition =
      before.length + prefix.length + insertion.length + suffix.length
    void nextTick(() => {
      input.value?.focus()
      input.value?.setSelectionRange(nextPosition, nextPosition)
      resize()
    })
  }

  async function toggleModeMenu(): Promise<void> {
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

  function selectMode(mode: ControlModeValue): void {
    if (props.busy) return
    closeModeMenu()
    if (mode !== currentMode.value.value) emit('set-permission', mode)
    input.value?.focus()
  }

  async function toggleModelMenu(): Promise<void> {
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
    return modelMenu.value
      ? Array.from(
          modelMenu.value.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled)',
          ),
        )
      : []
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
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key))
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

  function selectModel(entryId: string): void {
    if (props.busy) return
    closeModelMenu()
    if (entryId !== activeModelId.value) emit('switch-model', entryId)
    input.value?.focus()
  }

  function selectReasoning(value: string | null): void {
    if (props.busy) return
    const next = normalizeReasoningValue(value) || null
    if ((currentReasoningValue.value || '') !== (next || ''))
      emit('set-reasoning-effort', next)
  }

  function toggleAddMenu(): void {
    closeModelMenu()
    closeModeMenu()
    if (addMenuOpen.value) {
      closeAddMenu()
      return
    }
    addMenuOpen.value = true
    document.addEventListener('pointerdown', onAddMenuPointerDown, true)
  }

  function closeAddMenu(): void {
    if (!addMenuOpen.value) return
    addMenuOpen.value = false
    document.removeEventListener('pointerdown', onAddMenuPointerDown, true)
  }

  function closeModeMenu(): void {
    if (!modeMenuOpen.value) return
    modeMenuOpen.value = false
    modeFloatingMenu.removeListeners()
  }

  function closeModelMenu(): void {
    if (!modelMenuOpen.value) return
    modelMenuOpen.value = false
    modelFloatingMenu.removeListeners()
  }

  function closeComposerMenus(): void {
    closeAddMenu()
    closeModelMenu()
    closeModeMenu()
  }

  function onAddMenuPointerDown(event: PointerEvent): void {
    if (!(event.target instanceof Node)) return
    if (!shell.value?.contains(event.target)) closeAddMenu()
  }

  function pickFiles(): void {
    closeAddMenu()
    fileInput.value?.click()
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

  watch(
    () => props.goalCaptureStatus,
    (status, previous) => {
      if (previous !== 'starting' || status !== 'idle') return
      value.value = ''
      void nextTick(resize)
    },
  )

  onBeforeUnmount(closeComposerMenus)

  return {
    actionIcons,
    value,
    shell,
    input,
    highlightLayer,
    fileInput,
    modelButton,
    modelMenu,
    modeButton,
    modeMenu,
    drafts,
    uploading,
    dragActive,
    onFileInput,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    removeDraft,
    addMenuOpen,
    modelMenuOpen,
    modeMenuOpen,
    modelMenuStyle: modelFloatingMenu.style,
    modelMenuPlacement: modelFloatingMenu.placement,
    modeMenuStyle: modeFloatingMenu.style,
    modeMenuPlacement: modeFloatingMenu.placement,
    paletteMode,
    paletteGroups,
    activePaletteItem,
    paletteHeading,
    paletteHint,
    inlineSegments,
    hasInlineTokens,
    composerSlashParts,
    attachTitle: 'Add files and more',
    modeOptions,
    currentMode,
    modeTitle,
    permissionAppliesAfterPlan,
    goalCaptureActive,
    goalCaptureStarting,
    activeModelId,
    otherModelEntries,
    showModelSwitcher,
    currentModelLabel,
    currentProviderLabel,
    currentProviderIcon,
    currentProviderIconMonochrome,
    currentProviderMaskStyle,
    currentProviderFallback,
    currentModelId,
    currentProtocolLabel,
    currentReasoningLabel,
    currentReasoningValue,
    modelTitle,
    reasoningOptions,
    arcLength,
    arcColor,
    percentLabel,
    contextLabel,
    sendDisabled,
    stopPresentation,
    resize,
    syncHighlightScroll,
    submit,
    handleKeydown,
    applyPaletteItem,
    toggleAddMenu,
    closeComposerMenus,
    toggleModeMenu,
    closeModeMenu,
    selectMode,
    toggleModelMenu,
    closeModelMenu,
    onModelMenuKeydown,
    selectModel,
    selectReasoning,
    fmt,
    modelEntryLabel,
    providerLabel,
    providerIcon,
    providerFallback,
    protocolLabel,
    expose: { setDraft, focusInput, restoreDraft },
  }
}

function paletteItemFromSlash(
  item: SlashPaletteItem,
  _group: string,
): CapabilityPickerItem {
  return {
    id: item.id,
    action:
      item.name === '/plan'
        ? 'activate_plan'
        : item.name === '/goal'
          ? 'activate_goal'
          : 'insert_command',
    label: item.title,
    description: item.description,
    meta: item.kind === 'skill' ? item.sourceLabel : undefined,
    completion: item.completion,
    icon: item.kind === 'skill' ? toolIcon('skill') : commandIcon(item.name),
    tone: 'slate',
  }
}

function commandIcon(name: string): IconComponent {
  if (name === '/new') return actionIcons.commandNew
  if (name === '/compact') return actionIcons.commandCompact
  if (name === '/model') return actionIcons.commandModel
  if (name === '/reasoning') return actionIcons.commandReasoning
  if (name === '/permissions') return actionIcons.commandPermissions
  if (name === '/plan') return actionIcons.commandPlan
  if (name === '/goal') return actionIcons.commandGoal
  if (name === '/stop') return actionIcons.stop
  if (name === '/continue') return actionIcons.commandContinue
  return toolIcon('skill')
}

function appendInlineToken(text: string, token: string): string {
  const trimmed = text.trimEnd()
  return trimmed ? `${trimmed} ${token}` : token
}

function fmt(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function modelEntryLabel(entry: ModelEntry): string {
  return entry.effectiveDisplayName || entry.modelId || '模型'
}

function protocolLabel(protocol: 'openai' | 'anthropic'): string {
  return protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'
}

function normalizeReasoningValue(value?: string | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function reasoningLabel(value?: string | null): string {
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
