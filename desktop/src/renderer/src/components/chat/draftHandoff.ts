/**
 * A draft another page hands to the conversation it opens — the plugin
 * detail's 「立即试用」 creates a chat and leaves the example prompt in its
 * composer. The conversation takes it once, when that session is active,
 * and never sends it by itself.
 */
import { readonly, ref } from 'vue'

const handoff = ref<{ sessionId: string; text: string } | null>(null)

export const draftHandoff = readonly(handoff)

export function handDraftTo(sessionId: string, text: string): void {
  handoff.value = sessionId && text ? { sessionId, text } : null
}

/** The draft for `sessionId`, removed once taken. */
export function takeDraftHandoff(sessionId: string): string | null {
  const current = handoff.value
  if (!current || current.sessionId !== sessionId) return null
  handoff.value = null
  return current.text
}
