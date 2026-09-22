// Timeline-scoped context shared by every chat row: user actions routed up
// to ChatTimeline's emits, and the expansion store that keeps disclosure
// state across virtual-scroller unmount/remount.
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
}

export interface ExpansionStore {
  readonly open: Map<string, boolean>
  get(key: string, fallback: boolean): boolean
  set(key: string, value: boolean): void
}

export interface ChatContext {
  readonly actions: ChatActions
  readonly expansion: ExpansionStore
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
