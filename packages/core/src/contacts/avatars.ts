/**
 * A new contact's avatar (GRP-04, D21): recommended at random from the
 * avatar library's theme of its role template — a person, an animal or a
 * robot for a blank contact — skipping the avatars other contacts use. 「换
 * 一个」 draws again from the same theme and never offers the avatar on
 * screen again. The random source is injected (tests pass their own).
 */
import { ContactTemplateNotFoundError } from './errors'
import {
  AVATAR_SHEET_THEMES,
  LIBRARY_AVATAR_ID,
  type AvatarTheme,
  type Contact,
  type ContactTemplate,
} from './types'

/** Every library id in prompt order: AV-01-1 … AV-15-9. */
export const LIBRARY_AVATAR_IDS: readonly string[] = Object.freeze(
  Object.keys(AVATAR_SHEET_THEMES).flatMap((sheet) =>
    Array.from({ length: 9 }, (_, index) => `${sheet}-${index + 1}`),
  ),
)

/** Where a contact without a template gets its avatar from (D21). */
export const BLANK_AVATAR_THEMES: readonly AvatarTheme[] = Object.freeze([
  'people',
  'animals',
  'robots',
])

/** The theme of a library id (null: not a library id). */
export function libraryAvatarTheme(id: string): AvatarTheme | null {
  if (!LIBRARY_AVATAR_ID.test(id)) return null
  return AVATAR_SHEET_THEMES[id.slice(0, 5)] ?? null
}

export interface AvatarRecommendInput {
  themes: readonly AvatarTheme[]
  /** The library avatars other contacts use. */
  used: Iterable<string>
  /**
   * Avatars not to offer: the ones offered before, the last of them being
   * the one on screen now (never offered again while the theme has others).
   */
  exclude?: readonly string[]
  /** A number in [0, 1); Math.random by default. */
  random?: () => number
}

/**
 * One library id. Tries, in order: the theme's avatars nobody uses and not
 * offered before; then those not offered before (in use, but every free one
 * was offered or taken); then any but the one on screen; then any.
 */
export function recommendAvatar(input: AvatarRecommendInput): string {
  const themes = new Set(input.themes)
  const pool = LIBRARY_AVATAR_IDS.filter((id) => {
    const theme = libraryAvatarTheme(id)
    return theme !== null && themes.has(theme)
  })
  const used = new Set(input.used)
  const exclude = new Set(input.exclude ?? [])
  const current = input.exclude?.at(-1)
  const tiers = [
    pool.filter((id) => !used.has(id) && !exclude.has(id)),
    pool.filter((id) => !exclude.has(id)),
    pool.filter((id) => id !== current),
    pool,
  ]
  const choices = tiers.find((tier) => tier.length > 0) ?? []
  if (choices.length === 0)
    throw new Error('the avatar library has no avatar for these themes')
  const random = input.random ?? Math.random
  const index = Math.min(
    choices.length - 1,
    Math.max(0, Math.floor(random() * choices.length)),
  )
  return choices[index]!
}

export interface ContactAvatarRecommendDeps {
  contacts: readonly Pick<Contact, 'id' | 'avatar'>[]
  templates: readonly Pick<ContactTemplate, 'id' | 'avatarTheme'>[]
  random?: () => number
}

/** `contacts.recommendAvatar`: the template's theme, the contacts' avatars. */
export function recommendContactAvatar(
  input: { templateId?: string; exclude?: readonly string[] },
  deps: ContactAvatarRecommendDeps,
): { id: string; theme: AvatarTheme } {
  let themes = BLANK_AVATAR_THEMES
  if (input.templateId !== undefined) {
    const template = deps.templates.find(
      (candidate) => candidate.id === input.templateId,
    )
    if (!template) throw new ContactTemplateNotFoundError(input.templateId)
    themes = [template.avatarTheme]
  }
  const used = deps.contacts.flatMap((contact) =>
    contact.avatar.kind === 'library' ? [contact.avatar.id] : [],
  )
  const id = recommendAvatar({
    themes,
    used,
    ...(input.exclude ? { exclude: input.exclude } : {}),
    ...(deps.random ? { random: deps.random } : {}),
  })
  return { id, theme: libraryAvatarTheme(id)! }
}
