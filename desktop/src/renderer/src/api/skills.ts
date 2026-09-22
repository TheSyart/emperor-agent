import type { CoreOperationArgs, CoreOperationResult } from '@emperor/core/api'
import { invokeCore } from './backend'

/**
 * Typed wrappers of the Core `skills.*` operations used by Settings › Skills.
 * Every call takes the session whose project scopes the Skill catalog
 * (`sessionId`: null / omitted = no project, personal + builtin + plugin
 * only). Failures reject with the Core SkillError envelope mapped onto the
 * Error (`code`, `action`; see skillErrorInfo).
 */

export type SkillScope = 'user' | 'project'
export type SkillListResult = CoreOperationResult<'skills.list'>
export type SkillInfoPayload = SkillListResult['skills'][number]
export type InvalidSkillPayload = SkillListResult['invalid'][number]
export type SkillDetailPayload = CoreOperationResult<'skills.get'>
export type SkillValidationResult = CoreOperationResult<'skills.validate'>
export type SkillImportResult = CoreOperationResult<'skills.import'>
export type SkillImportInput = CoreOperationArgs<'skills.import'>[0]
export type SkillImportSource = SkillImportInput['source']
export type SkillDeleteResult = CoreOperationResult<'skills.delete'>

export interface SkillSessionOptions {
  sessionId?: string | null
}

/** Core SkillError codes (`skills.*` failures). */
export type SkillErrorCode =
  | 'skill_not_found'
  | 'skill_read_only'
  | 'skill_exists'
  | 'skill_invalid'
  | 'skill_import_failed'
  | 'skill_scope_unavailable'

export interface SkillErrorInfo {
  code: string | null
  /** Suggested follow-up (`copy_to_user`, `overwrite`). */
  action: string | null
  message: string
}

function scoped(options: SkillSessionOptions): { sessionId?: string | null } {
  return options.sessionId ? { sessionId: options.sessionId } : {}
}

/** Effective Skills of the session plus the invalid ones with reasons. */
export async function listSkills(
  options: SkillSessionOptions = {},
): Promise<SkillListResult> {
  return invokeCore('skills.list', scoped(options))
}

export async function getSkill(
  name: string,
  options: SkillSessionOptions = {},
): Promise<SkillDetailPayload> {
  return invokeCore('skills.get', name, scoped(options))
}

/** Save SKILL.md in place (read-only sources reject with skill_read_only). */
export async function saveSkill(
  name: string,
  content: string,
  options: SkillSessionOptions = {},
): Promise<SkillDetailPayload> {
  return invokeCore('skills.save', name, content, scoped(options))
}

/**
 * Delete a writable Skill. For an invalid Skill pass its folder (or `.md`
 * file) name plus the `scope` it was found in.
 */
export async function deleteSkill(
  name: string,
  options: SkillSessionOptions & { scope?: SkillScope | null } = {},
): Promise<SkillDeleteResult> {
  return invokeCore('skills.delete', name, {
    ...scoped(options),
    ...(options.scope ? { scope: options.scope } : {}),
  })
}

/** 「复制为个人 Skill」: copy a builtin / Plugin / project Skill into ~/.emperor/skills. */
export async function copySkillToUser(
  input: SkillSessionOptions & { name: string; overwrite?: boolean },
): Promise<SkillDetailPayload> {
  return invokeCore('skills.copyToUser', {
    name: input.name,
    ...scoped(input),
    ...(input.overwrite ? { overwrite: true } : {}),
  })
}

/** Import pasted SKILL.md, a folder, a zip file or an https (GitHub) URL. */
export async function importSkills(
  input: SkillSessionOptions & {
    source: SkillImportSource
    scope: SkillScope
    overwrite?: boolean
  },
): Promise<SkillImportResult> {
  return invokeCore('skills.import', {
    source: input.source,
    scope: input.scope,
    ...scoped(input),
    ...(input.overwrite ? { overwrite: true } : {}),
  })
}

/** Validate SKILL.md text (`content`, `name` = intended folder name) or an installed Skill. */
export async function validateSkill(
  input: SkillSessionOptions & { name?: string | null; content?: string },
): Promise<SkillValidationResult> {
  const name = String(input.name ?? '').trim()
  return invokeCore('skills.validate', {
    ...(name ? { name } : {}),
    ...(typeof input.content === 'string' ? { content: input.content } : {}),
    ...scoped(input),
  })
}

/** Read `code` / `action` / message off a rejected `skills.*` call. */
export function skillErrorInfo(error: unknown): SkillErrorInfo {
  const record =
    error && typeof error === 'object'
      ? (error as { code?: unknown; action?: unknown; message?: unknown })
      : {}
  const message =
    typeof record.message === 'string' && record.message
      ? record.message
      : String(error ?? '')
  return {
    code: typeof record.code === 'string' && record.code ? record.code : null,
    action:
      typeof record.action === 'string' && record.action ? record.action : null,
    message,
  }
}
