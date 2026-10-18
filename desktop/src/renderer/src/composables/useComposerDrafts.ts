import {
  isEmptyDraft,
  type ComposerDraft,
} from '../components/chat/composerDraft'

/**
 * Unsent composer drafts, one per session, for this window: switching
 * chats keeps what was typed (text, chips, uploaded attachments) with the
 * chat it was typed in. Memory only; a reload starts empty.
 */
const drafts = new Map<string, ComposerDraft>()

export function saveComposerDraft(
  sessionId: string,
  draft: ComposerDraft,
): void {
  if (!sessionId) return
  if (isEmptyDraft(draft)) drafts.delete(sessionId)
  else
    drafts.set(sessionId, {
      text: draft.text,
      references: draft.references.map((ref) => ({ ...ref })),
      attachments: [...draft.attachments],
    })
}

/** The saved draft of a session, removed from the store (null when none). */
export function takeComposerDraft(sessionId: string): ComposerDraft | null {
  const draft = drafts.get(sessionId) ?? null
  drafts.delete(sessionId)
  return draft
}

/** Test seam. */
export function clearComposerDrafts(): void {
  drafts.clear()
}
