// `useSessionConversation` for app-shell code that must not pull the raw-log
// conversation engine into the initial bundle: the engine module is loaded on
// first use and the handle is null until it arrives (the chat route loads the
// same chunk, so in practice it is already on its way).
import {
  effectScope,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  watch,
  type ShallowRef,
} from 'vue'
import type { ConversationHandle } from '../conversation/store'

export function useLazySessionConversation(
  sessionId: () => string,
): Readonly<ShallowRef<ConversationHandle | null>> {
  const handle = shallowRef<ConversationHandle | null>(null)
  const scope = effectScope()
  let stopped = false
  void import('./useSessionConversation').then(({ useSessionConversation }) => {
    if (stopped) return
    scope.run(() => {
      const inner = useSessionConversation(sessionId)
      watch(
        inner,
        (value) => {
          handle.value = value
        },
        { immediate: true },
      )
    })
  })
  if (getCurrentScope() !== undefined)
    onScopeDispose(() => {
      stopped = true
      scope.stop()
    })
  return handle
}
