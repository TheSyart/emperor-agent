// Timeline-scoped context shared by every chat row: user actions routed up
// to ChatTimeline's emits, the expansion store that keeps disclosure state
// across virtual-scroller unmount/remount, and the turn under the pointer.
import {
  computed,
  inject,
  provide,
  shallowReactive,
  type InjectionKey,
  type WritableComputedRef,
} from 'vue'

export interface ChatActions {
  inspect(callId: string): void
  openSubagent(sessionId: string): void
  editMessage(text: string): void
  /**
   * Keep row `key` where it is on screen while its height changes (a
   * process group the reader opens or folds).
   */
  holdRow?(key: string): void
}

export interface ExpansionStore {
  readonly open: Map<string, boolean>
  get(key: string, fallback: boolean): boolean
  set(key: string, value: boolean): void
}

export interface ChatContext {
  readonly actions: ChatActions
  readonly expansion: ExpansionStore
  /** The session the timeline shows ('' in galleries without one). */
  readonly sessionId: () => string
  readonly rootSessionId?: () => string
  /** The turn under the pointer (its turn tail shows copy and 用时). */
  readonly hoverTurn?: () => number | null
  /**
   * Subagent rows (UI-S14): each reports when it is on screen (the status
   * bar shows only while none at work is), and one may be lit up after
   * 「回到列表 ↑」.
   */
  readonly agentRows?: {
    observe(element: Element, id: string): () => void
    highlighted(): string | null
  }
}

const CHAT_CONTEXT: InjectionKey<ChatContext> = Symbol('chat-context')

export function createExpansionStore(): ExpansionStore {
  const open = shallowReactive(new Map<string, boolean>())
  return {
    open,
    get: (key, fallback) => open.get(key) ?? fallback,
    set: (key, value) => {
      open.set(key, value)
    },
  }
}

export function provideChatContext(context: ChatContext): void {
  provide(CHAT_CONTEXT, context)
}

const NOOP_CONTEXT: ChatContext = {
  actions: {
    inspect: () => undefined,
    openSubagent: () => undefined,
    editMessage: () => undefined,
  },
  expansion: createExpansionStore(),
  sessionId: () => '',
}

export function useChatContext(): ChatContext {
  return inject(CHAT_CONTEXT, NOOP_CONTEXT)
}

/**
 * Disclosure state for one row part, surviving virtual unmounts. `fallback`
 * applies until the user toggles (so status-driven defaults keep tracking).
 */
export function useExpansion(
  key: () => string,
  fallback: () => boolean = () => false,
): WritableComputedRef<boolean> {
  const { expansion } = useChatContext()
  return computed({
    get: () => expansion.get(key(), fallback()),
    set: (value) => expansion.set(key(), value),
  })
}
