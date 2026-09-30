/**
 * Dictation in the composer (VO-03). The 听写 button and the shortcut from
 * 设置 › 语音 start and stop one dictation for the chat on screen: partial
 * results show as a draft in the editor (editor/dictationDraft.ts) and the
 * final result goes in once, where dictation began. The button shows the
 * recording the whole time, and the recording stops as soon as you switch
 * chats or the composer goes away. A result that arrives after that is kept
 * in memory for its own chat and offered there; it is never written into
 * another chat. Nothing here sends a message.
 */
import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue'
import {
  cancelDictation,
  dictationStatus,
  dictationSupported,
  onDictationEvent,
  startDictation,
  stopDictation,
  type DictationErrorCode,
  type DictationEvent,
} from '../../api/dictation'
import { acceleratorMatches, dictationRequest } from '../../dictation/model'
import { useDictationSettings } from '../../dictation/settings'
import { detectShortcutPlatform } from '../../shortcuts'
import type { ComposerEditorHandle } from '../chat/composerController'
import { acceleratorLabel } from '../settings/computer/shortcut'

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing'

/** Results that arrived after their chat left the screen: chat → text. */
const kept = reactive(new Map<string, string>())
/** Dictations stopped because their chat left the screen: session → chat. */
const detached = new Map<string, string>()
let stopFollowing: (() => void) | null = null

function keep(chat: string, text: string): void {
  const clean = text.trim()
  if (!clean) return
  const earlier = kept.get(chat)
  kept.set(chat, earlier ? `${earlier} ${clean}` : clean)
}

/** One window-wide listener finishes dictations whose composer moved on. */
function followDetached(): void {
  stopFollowing ??= onDictationEvent((event) => {
    const chat = detached.get(event.session)
    if (chat === undefined) return
    if (event.type === 'final') keep(chat, event.text)
    if (event.type === 'final' || event.type === 'ended')
      detached.delete(event.session)
  })
}

/** Tests: forget kept results and the window-wide listener. */
export function forgetKeptDictationsForTest(): void {
  kept.clear()
  detached.clear()
  stopFollowing?.()
  stopFollowing = null
}

/** What to tell the user, with where to fix it when that is 设置 › 语音. */
export function dictationErrorText(
  code: DictationErrorCode,
  message: string,
): string {
  switch (code) {
    case 'permission_denied':
      return `${message}：到「设置 › 语音」查看两项权限`
    case 'no_device':
      return `${message}：可以在「设置 › 语音」选择麦克风`
    case 'unsupported_locale':
      return `${message}：可以在「设置 › 语音」换一种语言`
    case 'busy':
      return '已有一段听写正在进行'
    default:
      return `听写失败：${message}`
  }
}

export function useComposerDictation(options: {
  editor: Ref<ComposerEditorHandle | null>
  /** The chat whose draft this is; a change stops the dictation. */
  chat: () => string | null
  onError(message: string): void
}) {
  const supported = dictationSupported()
  const mac = detectShortcutPlatform() === 'mac'
  const { settings } = useDictationSettings()
  const phase = ref<DictationPhase>('idle')
  let session: string | null = null
  let owner: string | null = null
  let finalSeen = false
  /** Cancelled, or its chat left, while the start was on its way. */
  let abandoned: 'cancel' | 'detach' | null = null
  /** Events that came before the start answered with its session id. */
  let early: DictationEvent[] | null = null

  const shortcut = computed(() =>
    acceleratorLabel(settings.value.shortcut, mac),
  )
  const keptText = computed(() => {
    const chat = options.chat()
    return chat === null ? null : (kept.get(chat) ?? null)
  })

  function reset(): void {
    session = null
    owner = null
    finalSeen = false
    early = null
    phase.value = 'idle'
  }

  function onEvent(event: DictationEvent): void {
    if (early) {
      early.push(event)
      return
    }
    if (session === null || event.session !== session) return
    const editor = options.editor.value
    switch (event.type) {
      case 'started':
        if (phase.value === 'starting') phase.value = 'listening'
        return
      case 'partial':
        editor?.dictationPartial(session, event.text)
        return
      case 'final':
        if (finalSeen) return
        finalSeen = true
        if (editor) editor.dictationFinal(session, event.text)
        else if (owner !== null) keep(owner, event.text)
        return
      case 'error':
        options.onError(dictationErrorText(event.code, event.message))
        return
      case 'ended':
        editor?.dictationEnd(session)
        reset()
        return
    }
  }

  const stopListening = onDictationEvent(onEvent)

  function failed(message: string): void {
    reset()
    options.onError(message)
  }

  async function start(): Promise<void> {
    if (!supported || phase.value !== 'idle' || !options.editor.value) return
    phase.value = 'starting'
    abandoned = null
    early = []
    const chat = options.chat()
    try {
      const status = await dictationStatus()
      if (abandoned) return reset()
      if (!status.available)
        return failed(status.reason ?? '听写组件现在不可用')
      const result = await startDictation(
        dictationRequest(settings.value, status),
      )
      if (!result.ok)
        return failed(dictationErrorText(result.code, result.message))
      const pending = early ?? []
      early = null
      session = result.session
      owner = chat
      finalSeen = false
      if (abandoned === 'cancel' || !options.editor.value) {
        void cancelDictation(result.session)
        return reset()
      }
      if (abandoned === 'detach' || options.chat() !== chat) return detach()
      options.editor.value.dictationBegin(result.session)
      for (const event of pending) onEvent(event)
    } catch {
      failed('听写没有开始')
    }
  }

  /** Ends the recording; the final result follows. */
  function stop(): void {
    if (session === null || phase.value === 'finishing') return
    phase.value = 'finishing'
    void stopDictation(session)
  }

  /** Drops the dictation: nothing goes into the draft. */
  function cancel(): void {
    if (phase.value === 'idle') return
    if (session === null) {
      abandoned = 'cancel'
      return
    }
    const id = session
    options.editor.value?.dictationEnd(id)
    reset()
    void cancelDictation(id)
  }

  /**
   * The chat left the screen, or the composer did: the recording stops at
   * once and its result is kept for that chat.
   */
  function detach(): void {
    if (phase.value === 'idle') return
    if (session === null) {
      abandoned = 'detach'
      return
    }
    const id = session
    options.editor.value?.dictationEnd(id)
    if (!finalSeen && owner !== null) {
      detached.set(id, owner)
      followDetached()
    }
    reset()
    void stopDictation(id)
  }

  function toggle(): void {
    if (phase.value === 'idle') void start()
    else if (phase.value === 'starting') cancel()
    else if (phase.value === 'listening') stop()
  }

  /** The dictation shortcut, pressed in the editor; true when handled. */
  function handleKey(event: KeyboardEvent): boolean {
    if (!supported || event.isComposing) return false
    if (!acceleratorMatches(event, settings.value.shortcut, mac)) return false
    event.preventDefault()
    toggle()
    return true
  }

  let keptCount = 0
  /** A kept result goes in at the caret, as one undo step. */
  function insertKept(): void {
    const chat = options.chat()
    const editor = options.editor.value
    const text = chat === null ? undefined : kept.get(chat)
    if (chat === null || text === undefined || !editor) return
    keptCount += 1
    editor.dictationFinal(`kept-${keptCount}`, text)
    kept.delete(chat)
    editor.focus()
  }

  function discardKept(): void {
    const chat = options.chat()
    if (chat !== null) kept.delete(chat)
  }

  watch(options.chat, (next, previous) => {
    if (next !== previous) detach()
  })

  onBeforeUnmount(() => {
    detach()
    stopListening()
  })

  return {
    supported,
    phase,
    shortcut,
    keptText,
    toggle,
    cancel,
    handleKey,
    insertKept,
    discardKept,
  }
}
