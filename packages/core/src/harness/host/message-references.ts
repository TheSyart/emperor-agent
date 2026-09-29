/**
 * Skill and plugin references in a user message (E-track contract §2,
 * private-docs/specs/2026-09-30-references/00-契约.md): chips the composer
 * put in the text. `content.slice(start, end)` is `/id` (skill) or `@id`
 * (plugin). Renderer-only metadata: the model reads the text itself, where
 * the kernel's gestures pick the references up.
 */

export interface MessageReference {
  kind: 'skill' | 'plugin'
  id: string
  label: string
  start: number
  end: number
}

/** Skill names (`isSkillName`) and plugin IDs (`assertPluginId`). */
export const SKILL_REFERENCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const PLUGIN_REFERENCE_ID =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/

export const MAX_MESSAGE_REFERENCES = 32

export function referenceGesture(
  reference: Pick<MessageReference, 'kind' | 'id'>,
): string {
  return reference.kind === 'skill' ? `/${reference.id}` : `@${reference.id}`
}

/**
 * Whether `references` sit in `content` as the contract says: valid ids,
 * in order, not overlapping, each slice exactly its gesture.
 */
export function referencesFit(
  content: string,
  references: readonly MessageReference[],
): boolean {
  if (references.length > MAX_MESSAGE_REFERENCES) return false
  let last = 0
  for (const reference of references) {
    const pattern =
      reference.kind === 'skill' ? SKILL_REFERENCE_ID : PLUGIN_REFERENCE_ID
    if (
      !pattern.test(reference.id) ||
      !Number.isInteger(reference.start) ||
      !Number.isInteger(reference.end) ||
      reference.start < last ||
      reference.end > content.length ||
      content.slice(reference.start, reference.end) !==
        referenceGesture(reference)
    )
      return false
    last = reference.end
  }
  return true
}

/** Whether `content` already carries the `/name` gesture of a skill. */
export function hasSkillGesture(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)/${escaped}(?=\\s|$)`).test(content)
}
