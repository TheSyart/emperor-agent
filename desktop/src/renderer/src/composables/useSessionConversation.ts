// Follow one (changing) session id with an open conversation handle: the
// window for the current id is opened and retained, the previous one is
// released to the store's LRU. Draft and empty ids have no raw log yet and
// yield null (the view treats them as a blank conversation).
import {
  effectScope,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  watch,
  type EffectScope,
  type ShallowRef,
} from 'vue'
import { isDraftSessionId } from '../runtime/sessionDrafts'
import {
  useConversation,
  type ConversationHandle,
  type ConversationStore,
} from '../conversation/store'

export function useSessionConversation(
  sessionId: () => string,
  store?: ConversationStore,
): Readonly<ShallowRef<ConversationHandle | null>> {
  const handle = shallowRef<ConversationHandle | null>(null)
  let scope: EffectScope | null = null
  watch(
    sessionId,
    (id) => {
      if (handle.value?.sessionId === id) return
      scope?.stop()
      scope = null
      if (!id || isDraftSessionId(id)) {
        handle.value = null
        return
      }
      scope = effectScope()
      handle.value =
        scope.run(() =>
          store === undefined
            ? useConversation(id)
            : useConversation(id, store),
        ) ?? null
    },
    { immediate: true },
  )
  if (getCurrentScope() !== undefined) onScopeDispose(() => scope?.stop())
  return handle
}
