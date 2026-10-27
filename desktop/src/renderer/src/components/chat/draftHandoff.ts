/**
 * A draft another page hands to the conversation it opens — the plugin
 * detail's 「立即试用」 creates a chat and leaves the example prompt in its
 * composer. The conversation takes it once, when that session is active,
 * and never sends it by itself — unless it was handed over to be sent: the
 * Group home's @ of one contact opens that contact's single chat with the
 * message on its way (GRP-05).
 */
import { readonly, ref } from 'vue'

interface Handoff {
  sessionId: string
  text: string
  /** Send it as the user's message instead of filling the composer. */
  send?: true
}

const handoff = ref<Handoff | null>(null)

export const draftHandoff = readonly(handoff)

export function handDraftTo(
  sessionId: string,
  text: string,
  options: { send?: boolean } = {},
): void {
  handoff.value =
    sessionId && text
      ? { sessionId, text, ...(options.send ? { send: true as const } : {}) }
      : null
}

/** What was handed to `sessionId`, removed once taken. */
export function takeHandoff(
  sessionId: string,
): { text: string; send: boolean } | null {
  const current = handoff.value
  if (!current || current.sessionId !== sessionId) return null
  handoff.value = null
  return { text: current.text, send: current.send === true }
}

/** The draft for `sessionId`, removed once taken. */
export function takeDraftHandoff(sessionId: string): string | null {
  return takeHandoff(sessionId)?.text ?? null
}
