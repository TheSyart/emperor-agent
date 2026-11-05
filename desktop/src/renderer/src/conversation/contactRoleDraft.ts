/**
 * Untrusted tool-result metadata for the fixed role creator (CG-CT-01).
 * Core has already validated real drafts; this parser keeps malformed or
 * ambiguous metadata from becoming a confirmation button. Saving still
 * goes through ContactStore.create/update, never through the model.
 */
import type {
  Contact,
  ContactDraftInput,
  ContactPatch,
} from '@emperor/core/runtime-contract'

/** The serializable subset emitted by Core; no service module enters the UI. */
interface ContactRoleDraftMeta {
  kind: 'contact-role-draft'
  action: 'create' | 'edit'
  targetId?: string
  draft: ContactDraftInput
  patch?: ContactPatch
}

export type ContactDraftLike = ContactDraftInput & { id?: string }
export type ParsedContactRoleDraftMeta = Omit<ContactRoleDraftMeta, 'draft'> & {
  draft: ContactDraftInput & {
    name: string
    role: NonNullable<ContactDraftInput['role']>
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function editableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^ct-[a-z0-9-]+$/.test(value) &&
    !['ct-emperor', 'ct-claude-code', 'ct-codex', 'ct-role-creator'].includes(
      value,
    )
  )
}

export function contactRoleDraftMeta(
  value: unknown,
): ParsedContactRoleDraftMeta | null {
  if (!record(value) || value.kind !== 'contact-role-draft') return null
  if (value.action !== 'create' && value.action !== 'edit') return null
  if (!record(value.draft)) return null
  if (
    typeof value.draft.name !== 'string' ||
    value.draft.name.trim() === '' ||
    !record(value.draft.role) ||
    typeof value.draft.role.mission !== 'string' ||
    typeof value.draft.role.deliverable !== 'string'
  )
    return null
  if (value.action === 'create')
    return value as unknown as ParsedContactRoleDraftMeta
  if (!editableId(value.targetId) || !record(value.patch)) return null
  if (Object.values(value.patch).every((item) => item === undefined))
    return null
  return value as unknown as ParsedContactRoleDraftMeta
}

const FIELDS = [
  'name',
  'avatar',
  'intro',
  'domains',
  'role',
  'knowledge',
  'skills',
  'mcp',
  'capabilities',
  'groupHabit',
  'memory',
] as const

/** Exact role data, ignoring a saved contact's id/version/timestamps. */
export function contactDraftMatches(
  draft: ContactDraftInput,
  contact: ContactDraftInput | Pick<Contact, (typeof FIELDS)[number]>,
): boolean {
  const left = Object.fromEntries(FIELDS.map((key) => [key, draft[key]]))
  const right = Object.fromEntries(FIELDS.map((key) => [key, contact[key]]))
  return JSON.stringify(left) === JSON.stringify(right)
}
