/**
 * The home of a single chat with Claude Code or Codex (GRP-11, GRP-19):
 * the page before its first message. Once the chat has a delegation it
 * opens that delegation's page — when the chat comes on screen, and also
 * when the same chat is opened again on a page kept alive (KeepAlive keeps
 * the session id, so a watch alone never runs again). A lookup or a send
 * that answers after the user went elsewhere never moves them; a send's
 * state and refusal stay with the chat it was for.
 */
import { onActivated, onDeactivated, ref, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { core } from '../../api/http'
import {
  externalChatLocation,
  sendExternalChat,
} from '../contacts/externalChat'

export function useExternalChatHome(options: {
  /** The external chat on screen; null for any other page. */
  sessionId: () => string | null
  /** Whether that chat's home is still what the user looks at. */
  onScreen: (sessionId: string) => boolean
  go: (target: RouteLocationRaw) => Promise<unknown>
}) {
  const sending = ref<string | null>(null)
  const error = ref<{ sessionId: string; text: string } | null>(null)
  let active = true
  let generation = 0
  const here = (sessionId: string) => active && options.onScreen(sessionId)

  async function follow() {
    const current = ++generation
    const sessionId = options.sessionId()
    if (!sessionId) return
    try {
      const { delegationId } = await core('contacts.chatDelegation', {
        sessionId,
      })
      if (delegationId && current === generation && here(sessionId))
        await options.go(externalChatLocation(sessionId, delegationId))
    } catch {
      // The chat's own home stays; its first message tries again.
    }
  }
  watch(options.sessionId, follow, { immediate: true })
  onActivated(() => {
    active = true
    void follow()
  })
  onDeactivated(() => {
    active = false
    generation++
  })

  /** Send one message; true once Core took it (the caller clears its draft). */
  async function send(sessionId: string, text: string): Promise<boolean> {
    if (sending.value === sessionId) return false
    sending.value = sessionId
    if (error.value?.sessionId === sessionId) error.value = null
    try {
      const target = await sendExternalChat(sessionId, text)
      if (here(sessionId)) await options.go(target).catch(() => undefined)
      return true
    } catch (cause) {
      error.value = {
        sessionId,
        text: cause instanceof Error ? cause.message : String(cause),
      }
      return false
    } finally {
      if (sending.value === sessionId) sending.value = null
    }
  }
  return {
    send,
    sendingFor: (sessionId: string) => sending.value === sessionId,
    errorFor: (sessionId: string) =>
      error.value?.sessionId === sessionId ? error.value.text : '',
  }
}
