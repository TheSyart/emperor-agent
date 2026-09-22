/**
 * The one Skill name rule shared by the loader, the Skill service, chat
 * `requestedSkills`, and the kernel `/name` gesture: lowercase letters and
 * digits, then any of lowercase letters, digits, `.`, `_`, or `-` (at most
 * {@link SKILL_NAME_MAX_LENGTH} characters). A Skill's name is its
 * frontmatter `name`; the folder name only produces a warning on mismatch.
 */

export const SKILL_NAME_MAX_LENGTH = 64
/** Regex source of one Skill name (no anchors), for composed patterns. */
export const SKILL_NAME_SOURCE = '[a-z0-9][a-z0-9._-]*'
export const SKILL_NAME = new RegExp(`^${SKILL_NAME_SOURCE}$`)

export function isSkillName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= SKILL_NAME_MAX_LENGTH &&
    SKILL_NAME.test(value)
  )
}

/** Human-readable reason a name is not a Skill name ('' when it is). */
export function skillNameError(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) return 'Skill name is required'
  if (name.length > SKILL_NAME_MAX_LENGTH)
    return `Skill name must be at most ${SKILL_NAME_MAX_LENGTH} characters`
  if (!SKILL_NAME.test(name))
    return 'Skill name must start with a lowercase letter or digit and use only lowercase letters, digits, ".", "_" or "-"'
  return ''
}

/** A fresh global matcher of `/skill-name` gestures in user text (group 2 = name). */
export function skillGesturePattern(): RegExp {
  return new RegExp(`(^|\\s)\\/(${SKILL_NAME_SOURCE})(?=\\s|$)`, 'g')
}
