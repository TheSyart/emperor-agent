import { EmperorError } from '../errors'

export type SkillErrorCode =
  | 'skill_not_found'
  | 'skill_read_only'
  | 'skill_exists'
  | 'skill_invalid'
  | 'skill_import_failed'
  | 'skill_scope_unavailable'

/** A Skill operation failure whose message is safe to show in the UI and to the model. */
export class SkillError extends EmperorError {
  declare readonly code: SkillErrorCode

  constructor(
    message: string,
    code: SkillErrorCode,
    options: { action?: string; cause?: unknown } = {},
  ) {
    super(message, code, {
      ...(options.action ? { action: options.action } : {}),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    })
  }
}
