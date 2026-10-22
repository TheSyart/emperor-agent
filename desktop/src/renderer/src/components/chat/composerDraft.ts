import type { AttachmentRef, MessageReference } from '../../types'

/** Everything the composer holds for one message that has not been sent. */
export interface ComposerDraft {
  text: string
  references: MessageReference[]
  attachments: AttachmentRef[]
}

export const EMPTY_DRAFT: Readonly<ComposerDraft> = Object.freeze({
  text: '',
  references: [],
  attachments: [],
})

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.text.trim().length === 0 && draft.attachments.length === 0
}

/**
 * Put `incoming` into a composer that may already hold text: an empty
 * composer takes it as is; otherwise it goes after a blank line, chips
 * moving with it, so nothing the user typed is overwritten.
 */
export function mergeDrafts(
  current: ComposerDraft,
  incoming: ComposerDraft,
): ComposerDraft {
  const currentText = current.text.trimEnd()
  const attachments = [...current.attachments]
  for (const item of incoming.attachments)
    if (!attachments.some((existing) => existing.id === item.id))
      attachments.push(item)
  if (currentText.length === 0)
    return {
      text: incoming.text,
      references: incoming.references.map((ref) => ({ ...ref })),
      attachments,
    }
  if (incoming.text.length === 0 || incoming.text === current.text)
    return {
      text: current.text,
      references: current.references.map((ref) => ({ ...ref })),
      attachments,
    }
  const offset = currentText.length + 2
  return {
    text: `${currentText}\n\n${incoming.text}`,
    references: [
      ...current.references
        .filter((ref) => ref.end <= currentText.length)
        .map((ref) => ({ ...ref })),
      ...incoming.references.map((ref) => ({
        ...ref,
        start: ref.start + offset,
        end: ref.end + offset,
      })),
    ],
    attachments,
  }
}
