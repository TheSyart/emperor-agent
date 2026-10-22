import type { CommandCompletion } from '@emperor/core/api'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { CapabilityPickerItem } from '../../capabilities/capabilityPicker'
import type { SlashPaletteItem } from '../../commands'
import type { GoalCaptureStatus } from '../../composables/goalCapture'
import type { ComposerLifecycleMode } from '../../composables/composerLifecycle'
import { useAttachments } from '../../composables/useAttachments'
import { captureScreenshot } from '../../api/screenshot'
import type {
  ChatSendPayload,
  ControlPayload,
  CurrentModelConfig,
  MessageReference,
  ModelEntry,
  PluginSummary,
  ProviderOption,
  RequestedSkill,
  RuntimeGoalView,
} from '../../types'
import type {
  ComposerOutput,
  ComposerReferenceKind,
  ComposerTrigger,
} from '../composer/editor/composerDocument'
import {
  composerSendDisabled,
  composerStopPresentation,
  type ControlModeValue,
} from './composerControls'
import {
  EMPTY_DRAFT,
  isEmptyDraft,
  mergeDrafts,
  type ComposerDraft,
} from './composerDraft'
import { useComposerModelControl } from './composerModelControl'
import { useComposerPalette } from './composerPalette'
import { findSecrets, maskSecrets } from './secretScan'

/**
 * The composer's behaviour (ComposerCard.vue is its view): the draft in the
 * rich editor, attachments and the screenshot, sending (with the queue
 * slot, uploads, the key prompt and a refused send put back), Goal capture,
 * the keys, and the lists (composerPalette.ts) and permission / model
 * controls (composerModelControl.ts) it is built from.
 */
export interface ComposerControllerProps {
  busy: boolean
  commands: SlashPaletteItem[]
  /** Installed plugins (`@` references, RF-03); none: no `@` list. */
  plugins?: readonly PluginSummary[]
  contextUsed: number
  contextMax: number
  control?: ControlPayload | null
  currentModel?: CurrentModelConfig | null
  modelEntries: ModelEntry[]
  providerOptions: ProviderOption[]
  supportsVision?: boolean
  sendBlockedReason?: string | null
  /**
   * No session to act on here (「没有找到这个会话」, F1): nothing can be
   * typed, sent or switched, and this is the placeholder.
   */
  unavailableReason?: string | null
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
  /**
   * Send one message. `false` (or a promise of it) means it was refused:
   * the composer puts the draft back, after anything typed since.
   */
  onSend?: (payload: ChatSendPayload) => boolean | Promise<boolean> | void
}

export interface ComposerEmit {
  (event: 'stop'): void
  (event: 'error', message: string): void
  (event: 'set-permission', mode: ControlModeValue): void
  (event: 'switch-model', entryId: string): void
  (event: 'set-reasoning-effort', level: string | null): void
  (event: 'activate-plan'): void
  (event: 'activate-goal'): void
  (event: 'dismiss-lifecycle'): void
  (event: 'start-goal', outcome: string): void
  /** A plugin that cannot be referenced now was picked: show its detail. */
  (event: 'open-plugin', target: { pluginId: string; scope: string }): void
}

export const COMPOSER_ACCEPT_LIST =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,application/json,text/csv,text/plain,text/markdown'
/** dsh draft cap: 14 lines × 24px (the takeover bodies share it). */
export const COMPOSER_TEXT_MAX_HEIGHT = 336
export const COMPOSER_QUEUE_FULL_MESSAGE =
  '已有一条消息排队，请先编辑、插入或删除后再发送。'
export const COMPOSER_UPLOADING_MESSAGE = '附件还在上传，上传完成后再发送。'

/** What the controller asks of the rich editor (ComposerEditor's expose). */
export interface ComposerEditorHandle {
  focus(): void
  setContent(text: string, references?: readonly MessageReference[]): void
  insertChip(kind: ComposerReferenceKind, id: string, label: string): void
  replaceWithChip(
    from: number,
    to: number,
    kind: ComposerReferenceKind,
    id: string,
    label: string,
  ): void
  chipifyTyped(): void
  output(): ComposerOutput
  dictationBegin(session: string): void
  dictationPartial(session: string, text: string): void
  dictationFinal(session: string, text: string): boolean
  dictationEnd(session: string): void
}

export function useComposerController(
  props: Readonly<ComposerControllerProps>,
  emit: ComposerEmit,
) {
  const value = ref('')
  const editor = ref<ComposerEditorHandle | null>(null)
  /** Chips in `value`. */
  const references = ref<MessageReference[]>([])
  /** A `/` or `@` being typed at the caret. */
  const trigger = ref<ComposerTrigger | null>(null)
  const shell = ref<HTMLElement | null>(null)
  const fileInput = ref<HTMLInputElement | null>(null)
  const attachments = useAttachments({
    onError: (message) => emit('error', message),
  })
  const { drafts, uploading, takeDrafts, restoreDrafts, handleFiles } =
    attachments
  /** A message that looks like it holds a key, waiting for the user's choice. */
  const secretPrompt = ref<ChatSendPayload | null>(null)
  const palette = useComposerPalette(props, { value, trigger, shell })
  const controls = useComposerModelControl(props, emit, focusInput)

  const goalCaptureActive = computed(
    () =>
      props.goalCaptureStatus === 'armed' ||
      props.goalCaptureStatus === 'starting',
  )
  const goalCaptureStarting = computed(
    () => props.goalCaptureStatus === 'starting',
  )
  const sendDisabled = computed(
    () =>
      Boolean(props.unavailableReason) ||
      goalCaptureStarting.value ||
      props.interactionBlocked ||
      uploading.value.size > 0 ||
      composerSendDisabled({
        busy: props.busy,
        content: value.value,
        attachmentCount: drafts.value.length,
        queueOccupied: props.queueOccupied,
        sendBlockedReason: props.sendBlockedReason || null,
      }),
  )
  /** Nothing to send yet: the send slot holds the microphone. */
  const hasDraft = computed(
    () => value.value.trim().length > 0 || drafts.value.length > 0,
  )
  const stopPresentation = computed(() =>
    composerStopPresentation(Boolean(props.goal)),
  )

  /** The message to send: typed known names become chips first. */
  function composed(): {
    content: string
    requestedSkills: RequestedSkill[]
    references: MessageReference[]
  } {
    editor.value?.chipifyTyped()
    const raw = value.value
    const leading = raw.length - raw.trimStart().length
    const content = raw.trim()
    const refs = references.value
      .map((reference) => ({
        ...reference,
        start: reference.start - leading,
        end: reference.end - leading,
      }))
      .filter(
        (reference) => reference.start >= 0 && reference.end <= content.length,
      )
    return { content, requestedSkills: skillsOf(refs), references: refs }
  }

  function submit(delivery?: 'queue' | 'interject'): void {
    if (props.unavailableReason || goalCaptureStarting.value) return
    if (props.sendBlockedReason) {
      emit('error', props.sendBlockedReason)
      return
    }
    const normalized = composed()
    const content = normalized.content
    if (props.busy) {
      if (!content && drafts.value.length === 0) return
      if (props.queueOccupied) {
        emit('error', COMPOSER_QUEUE_FULL_MESSAGE)
        return
      }
    }
    // An attachment still uploading would land in the next message.
    if (uploading.value.size > 0) {
      emit('error', COMPOSER_UPLOADING_MESSAGE)
      return
    }
    if (!props.busy && goalCaptureActive.value) {
      if (drafts.value.length > 0 || normalized.references.length > 0) {
        emit('error', '目标描述暂仅支持纯文字；请先移除附件或 Skill 引用。')
        return
      }
      if (!content) return
      emit('start-goal', content)
      closeComposerMenus()
      return
    }
    if (!content && drafts.value.length === 0) return
    const payload: ChatSendPayload = {
      content,
      attachments: [...drafts.value],
      requestedSkills: normalized.requestedSkills,
      displayContent: content,
      ...(normalized.references.length
        ? { references: normalized.references }
        : {}),
      ...(props.busy ? { delivery: delivery || 'queue' } : {}),
    }
    if (findSecrets(content).length > 0) {
      secretPrompt.value = payload
      return
    }
    dispatch(payload)
  }

  /** The key prompt's answer: mask and send, send as is, or keep editing. */
  function resolveSecretPrompt(choice: 'mask' | 'send' | 'cancel'): void {
    const payload = secretPrompt.value
    secretPrompt.value = null
    if (!payload || choice === 'cancel') {
      focusInput()
      return
    }
    if (choice === 'send') {
      dispatch(payload)
      return
    }
    const masked = maskSecrets(payload.content, payload.references ?? [])
    const { references: _references, ...rest } = payload
    dispatch({
      ...rest,
      content: masked.content,
      displayContent: masked.content,
      ...(masked.references.length ? { references: masked.references } : {}),
      requestedSkills: skillsOf(masked.references),
    })
  }

  /**
   * Clear the composer and hand the message over. If it is refused, the
   * draft as it was (unmasked text, chips, attachments) comes back, after
   * anything typed since.
   */
  function dispatch(payload: ChatSendPayload): void {
    const sent: ComposerDraft = {
      text: value.value,
      references: references.value.map((reference) => ({ ...reference })),
      attachments: takeDrafts(),
    }
    setText('')
    closeComposerMenus()
    let outcome: boolean | Promise<boolean> | void
    try {
      outcome = props.onSend?.({ ...payload, attachments: sent.attachments })
    } catch (error) {
      emit('error', errorText(error))
      outcome = false
    }
    void Promise.resolve(outcome).then(
      (accepted) => {
        if (accepted === false) putBack(sent)
      },
      (error: unknown) => {
        emit('error', errorText(error))
        putBack(sent)
      },
    )
  }

  /** Everything the composer holds now. */
  function takeSnapshot(): ComposerDraft {
    return {
      text: value.value,
      references: references.value.map((reference) => ({ ...reference })),
      attachments: [...drafts.value],
    }
  }

  /** Replace the whole draft (another chat's, or none). */
  function applySnapshot(draft: ComposerDraft | null): void {
    secretPrompt.value = null
    const next = draft ?? EMPTY_DRAFT
    setText(next.text, next.references)
    drafts.value = [...next.attachments]
  }

  /** Bring a draft back without overwriting what is in the composer. */
  function putBack(draft: ComposerDraft): void {
    applySnapshot(mergeDrafts(takeSnapshot(), draft))
    void nextTick(focusInput)
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!palette.activeItem.value) return
      event.preventDefault()
      palette.move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Escape') {
      if (palette.dismiss()) event.preventDefault()
      return
    }
    if (event.key === 'Tab' && palette.activeItem.value) {
      event.preventDefault()
      applyPaletteItem(palette.activeItem.value)
      return
    }
    // An input method's Enter confirms its candidate, never sends.
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.isComposing ||
      event.keyCode === 229
    )
      return
    event.preventDefault()
    const exact = palette.exactCommand.value
    const token = value.value.match(/^\/\S+/)?.[0] || ''
    if (
      palette.activeItem.value &&
      (palette.mode.value === 'mention' ||
        !exact ||
        palette.selectionIndex.value > 0 ||
        palette.argumentCompletions.value.length > 0)
    ) {
      applyPaletteItem(palette.activeItem.value)
      return
    }
    if (
      exact?.requiresArguments &&
      value.value.trim().toLowerCase() === token.toLowerCase()
    ) {
      setText(`${value.value.trimEnd()} `, references.value)
      return
    }
    submit()
  }

  /**
   * Replace the draft. The editor rebuilds its chips: from `references`
   * when given, else from the known names in the text.
   */
  function setText(text: string, refs?: readonly MessageReference[]): void {
    if (editor.value) {
      editor.value.setContent(text, refs)
      return
    }
    value.value = text
    references.value = []
  }

  function onEditorChange(output: ComposerOutput): void {
    value.value = output.content
    references.value = output.references
  }

  // A draft set before the editor mounted (a restored draft) moves in.
  watch(editor, (instance) => {
    if (instance && value.value) instance.setContent(value.value)
  })

  /**
   * Put text in the composer (an edited or queued message, a handed-over
   * draft). Text already there stays; the new text goes after it.
   */
  function setDraft(text: string, refs?: readonly MessageReference[]): void {
    if (isEmptyDraft(takeSnapshot())) setText(text, refs)
    else {
      const merged = mergeDrafts(takeSnapshot(), {
        text,
        references: [...(refs ?? [])],
        attachments: [],
      })
      // Without chip data the editor rebuilds chips from known names.
      setText(merged.text, refs === undefined ? undefined : merged.references)
    }
    void nextTick(focusInput)
  }

  function focusInput(): void {
    editor.value?.focus()
  }

  /** A message that came back (an edited queued prompt): text, chips, files. */
  function restoreDraft(payload: ChatSendPayload): void {
    const text = String(payload.displayContent || payload.content || '')
    if (isEmptyDraft(takeSnapshot())) {
      setText(text, payload.references)
      restoreDrafts(payload.attachments || [])
    } else
      applySnapshot(
        mergeDrafts(takeSnapshot(), {
          text,
          references: [...(payload.references ?? [])],
          attachments: [...(payload.attachments ?? [])],
        }),
      )
    void nextTick(focusInput)
  }

  function applyPaletteItem(item: CapabilityPickerItem | undefined): void {
    if (!item) return
    if (item.action === 'files') {
      closeComposerMenus()
      pickFiles()
      return
    }
    if (item.action === 'insert_reference' && item.reference) {
      insertReference(item.reference)
      return
    }
    if (item.action === 'open_plugin' && item.plugin) {
      // Nothing is inserted; the typed `@query` stays and its list closes.
      palette.dismissTrigger()
      closeComposerMenus()
      emit('open-plugin', item.plugin)
      return
    }
    if (item.action === 'activate_plan' || item.action === 'activate_goal') {
      if (palette.mode.value === 'slash') setText('')
      closeComposerMenus()
      if (item.action === 'activate_plan') emit('activate-plan')
      else emit('activate-goal')
      focusInput()
      return
    }
    if (!item.completion) return
    setText(item.completion)
    palette.reset()
    closeComposerMenus()
    focusInput()
  }

  /**
   * A chip from a list: in place of the typed `/query`, or at the caret
   * from the + menu's list.
   */
  function insertReference(reference: {
    kind: ComposerReferenceKind
    id: string
    label: string
  }): void {
    const fromTyping = palette.mode.value !== 'add'
    const current = trigger.value
    closeComposerMenus()
    palette.reset()
    const handle = editor.value
    if (!handle) return
    if (fromTyping && current)
      handle.replaceWithChip(
        current.from,
        current.to,
        reference.kind,
        reference.id,
        reference.label,
      )
    else handle.insertChip(reference.kind, reference.id, reference.label)
  }

  function closeComposerMenus(): void {
    palette.closeAdd()
  }

  function pickFiles(): void {
    palette.closeAdd()
    fileInput.value?.click()
  }

  /**
   * + › 截图: macOS's own region capture (main, screenshot-ipc.ts). The
   * picture is attached like a pasted image; Esc attaches nothing.
   */
  async function takeScreenshot(): Promise<void> {
    closeComposerMenus()
    try {
      const file = await captureScreenshot()
      if (file) await handleFiles([file])
    } catch (error) {
      emit('error', errorText(error))
    }
    focusInput()
  }

  watch(
    () => props.goalCaptureStatus,
    (status, previous) => {
      if (previous !== 'starting' || status !== 'idle') return
      setText('')
    },
  )

  onBeforeUnmount(closeComposerMenus)

  return {
    value,
    editor,
    catalog: palette.catalog,
    onEditorChange,
    onEditorTrigger: palette.onTrigger,
    focusInput,
    shell,
    fileInput,
    ...attachments,
    hasDraft,
    unknownSlashHint: palette.unknownSlashHint,
    secretPrompt,
    resolveSecretPrompt,
    paletteMode: palette.mode,
    paletteGroups: palette.groups,
    activePaletteItem: palette.activeItem,
    paletteHeading: palette.heading,
    paletteHint: palette.hint,
    ...controls,
    goalCaptureActive,
    goalCaptureStarting,
    sendDisabled,
    stopPresentation,
    submit,
    handleKeydown,
    applyPaletteItem,
    toggleAddMenu: palette.toggleAdd,
    closeComposerMenus,
    pickFiles,
    takeScreenshot,
    expose: {
      setDraft,
      focusInput,
      restoreDraft,
      takeSnapshot,
      applySnapshot,
    },
  }
}

/** Skills a message names: one request per distinct chip. */
function skillsOf(references: readonly MessageReference[]): RequestedSkill[] {
  return [
    ...new Set(
      references
        .filter((reference) => reference.kind === 'skill')
        .map((reference) => reference.id),
    ),
  ].map((name) => ({ name, source: 'slash' as const }))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
