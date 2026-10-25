// Messages inserted into the running turn that its log has not shown yet
// (BUG-07). The host writes their user message when the next step starts;
// until then the chat shows them as provisional bubbles, from 插入当前执行
// (or a 插话 send) until that user message arrives. Display only: nothing
// here reaches Core. It lives with the conversation, not in useRuntime, so
// the app's first load stays within its bundle budget.
import {
  computed,
  effectScope,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'
import { onCoreEvent } from '../../api/backend'
import { eventOwnerSessionId } from '../../runtime/sessionProjection'
import type { ProvisionalPrompt, QueuedPromptItem } from '../../types'

export interface ProvisionalSources {
  queuedPrompts: Ref<QueuedPromptItem[]>
  busy: Ref<boolean>
  sessionId: Ref<string>
  /** Live runtime events; the desktop bridge by default. */
  subscribe?: (listener: (event: unknown) => void) => () => void
}

export interface ProvisionalPrompts {
  /** The current session's provisional bubbles, oldest first. */
  shown: ComputedRef<ProvisionalPrompt[]>
  /** What the queue dock lists: queued and held prompts, not insertions. */
  dock: ComputedRef<QueuedPromptItem[]>
  /** 插入当前执行 was accepted for `prompt`. */
  interjected(prompt: QueuedPromptItem): void
  dispose(): void
}

function entry(prompt: QueuedPromptItem, sessionId: string): ProvisionalPrompt {
  return {
    id: prompt.id,
    clientMessageId: prompt.clientMessageId || prompt.id,
    content: prompt.content,
    ...(prompt.references?.length ? { references: prompt.references } : {}),
    createdOrder: prompt.createdOrder,
    sessionId,
  }
}

export function createProvisionalPrompts(
  sources: ProvisionalSources,
): ProvisionalPrompts {
  const scope = effectScope(true)
  const held = ref<ProvisionalPrompt[]>([])
  const same = (a: ProvisionalPrompt, id: string) =>
    a.id === id || a.clientMessageId === id
  function hold(prompt: ProvisionalPrompt, replace = false) {
    const known = held.value.some((h) => same(h, prompt.id))
    if (known && !replace) return
    held.value = [...held.value.filter((h) => !same(h, prompt.id)), prompt]
  }
  function drop(id: string) {
    if (id) held.value = held.value.filter((h) => !same(h, id))
  }

  const stop = (sources.subscribe ?? onCoreEvent)((input) => {
    if (!input || typeof input !== 'object') return
    const data = input as Record<string, unknown>
    const owner = eventOwnerSessionId(data) || sources.sessionId.value
    if (data.event === 'prompt_interjected') {
      const id = String(data.prompt_id ?? '')
      if (!id) return
      const queued = sources.queuedPrompts.value.find(
        (p) => p.id === id || p.clientMessageId === id,
      )
      if (queued) hold(entry(queued, owner))
      else if (typeof data.content === 'string')
        hold({
          id,
          clientMessageId: id,
          content: data.content,
          createdOrder: Date.now(),
          sessionId: owner,
        })
    } else if (data.event === 'user_message')
      drop(String(data.client_message_id ?? ''))
    else if (data.event === 'queue_item_state' && data.state === 'discarded')
      drop(String(data.prompt_id ?? ''))
  })

  const shown = scope.run(() => {
    // An insertion Core moved back to the queue (its turn ended first), or
    // one gone while nothing runs, is no longer provisional.
    watch([sources.queuedPrompts, sources.busy], ([queued, busy]) => {
      held.value = held.value.filter((h) => {
        if (h.sessionId !== sources.sessionId.value) return true
        const record = queued.find(
          (p) => p.id === h.id || p.clientMessageId === h.clientMessageId,
        )
        return record ? record.delivery === 'interject' : busy
      })
    })
    return computed<ProvisionalPrompt[]>(() => {
      const session = sources.sessionId.value
      const own = held.value.filter((h) => h.sessionId === session)
      // A message sent straight as 插话 is in the queue as `interjecting`.
      const sending = sources.queuedPrompts.value
        .filter(
          (p) =>
            p.status === 'interjecting' &&
            !own.some((h) => same(h, p.id) || same(h, p.clientMessageId)),
        )
        .map((p) => entry(p, session))
      return [...own, ...sending].sort(
        (a, b) => a.createdOrder - b.createdOrder,
      )
    })
  })!
  const dock = scope.run(() =>
    computed(() =>
      sources.queuedPrompts.value.filter((p) => p.status !== 'interjecting'),
    ),
  )!

  return {
    shown,
    dock,
    interjected: (prompt) => hold(entry(prompt, sources.sessionId.value), true),
    dispose() {
      stop()
      scope.stop()
    },
  }
}

let shared: ProvisionalPrompts | null = null

/** The app's one store (the sources are app-wide); it outlives the view. */
export function useProvisionalPrompts(
  sources: ProvisionalSources,
): ProvisionalPrompts {
  return (shared ??= createProvisionalPrompts(sources))
}
