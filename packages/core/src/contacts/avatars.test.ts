// GRP-04 (D21): a new contact's avatar is recommended at random from its
// template's theme, skipping the avatars other contacts use; 「换一个」 never
// offers the one on screen again. The random source is injected.
import { describe, expect, it } from 'vitest'
import {
  BLANK_AVATAR_THEMES,
  LIBRARY_AVATAR_IDS,
  libraryAvatarTheme,
  recommendAvatar,
  recommendContactAvatar,
} from './avatars'
import type { Contact, ContactTemplate } from './types'

/** A random source that walks 0, 1/n, 2/n, … so every pick is reached. */
function sweep(n: number): () => number {
  let i = 0
  return () => (i++ % n) / n
}

const ENGINEERING = LIBRARY_AVATAR_IDS.filter(
  (id) => libraryAvatarTheme(id) === 'engineering',
)

describe('the library', () => {
  it('has 135 ids, AV-01-1 … AV-15-9, each with a theme', () => {
    expect(LIBRARY_AVATAR_IDS).toHaveLength(135)
    expect(LIBRARY_AVATAR_IDS[0]).toBe('AV-01-1')
    expect(LIBRARY_AVATAR_IDS.at(-1)).toBe('AV-15-9')
    for (const id of LIBRARY_AVATAR_IDS)
      expect(libraryAvatarTheme(id), id).not.toBeNull()
    expect(ENGINEERING).toHaveLength(18)
    expect(libraryAvatarTheme('AV-16-1')).toBeNull()
    expect(libraryAvatarTheme('portrait')).toBeNull()
  })
})

describe('recommendAvatar (card tests 1–3)', () => {
  it('picks from the theme and skips the avatars other contacts use', () => {
    const used = ENGINEERING.slice(0, 15)
    const seen = new Set<string>()
    const random = sweep(40)
    for (let i = 0; i < 40; i++) {
      const id = recommendAvatar({ themes: ['engineering'], used, random })
      expect(libraryAvatarTheme(id)).toBe('engineering')
      expect(used).not.toContain(id)
      seen.add(id)
    }
    // Every free avatar of the theme comes up.
    expect([...seen].sort()).toEqual(ENGINEERING.slice(15).sort())
  })

  it('allows a repeat once every avatar of the theme is in use', () => {
    const id = recommendAvatar({
      themes: ['engineering'],
      used: ENGINEERING,
      random: () => 0.5,
    })
    expect(ENGINEERING).toContain(id)
  })

  it('never offers the avatar on screen again (换一个)', () => {
    const current = ENGINEERING[3]!
    const random = sweep(30)
    for (let i = 0; i < 30; i++) {
      // Even when everything else is used or was offered before.
      expect(
        recommendAvatar({
          themes: ['engineering'],
          used: ENGINEERING,
          exclude: [current],
          random,
        }),
      ).not.toBe(current)
      expect(
        recommendAvatar({
          themes: ['engineering'],
          used: [],
          exclude: [...ENGINEERING.filter((id) => id !== current), current],
          random,
        }),
      ).not.toBe(current)
    }
  })

  it('skips the avatars offered before while others are left', () => {
    const offered = ENGINEERING.slice(0, 17)
    expect(
      recommendAvatar({
        themes: ['engineering'],
        used: [],
        exclude: offered,
        random: () => 0,
      }),
    ).toBe(ENGINEERING[17])
  })

  it('takes a blank contact’s avatar from people, animals and robots', () => {
    expect([...BLANK_AVATAR_THEMES].sort()).toEqual(
      ['animals', 'people', 'robots'].sort(),
    )
    const random = sweep(50)
    const themes = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const id = recommendAvatar({
        themes: BLANK_AVATAR_THEMES,
        used: [],
        random,
      })
      themes.add(libraryAvatarTheme(id)!)
    }
    expect([...themes].sort()).toEqual(['animals', 'people', 'robots'])
  })

  it('is the same pick for the same random number', () => {
    const pick = (value: number) =>
      recommendAvatar({ themes: ['design'], used: [], random: () => value })
    expect(pick(0)).toBe('AV-03-1')
    expect(pick(0.999)).toBe('AV-03-9')
    expect(pick(0.5)).toBe(pick(0.5))
  })
})

describe('recommendContactAvatar', () => {
  const template = {
    id: 'security-auditor',
    avatarTheme: 'engineering',
  } as ContactTemplate
  const contact = (id: string, avatar: Contact['avatar']) =>
    ({ id, avatar }) as Contact

  it('uses the template’s theme and the library avatars of the contacts', () => {
    const contacts = [
      ...ENGINEERING.slice(0, 17).map((id, i) =>
        contact(`ct-a${i}`, { kind: 'library', id }),
      ),
      contact('ct-emperor', { kind: 'mascot', pose: 'crown-head' }),
      contact('ct-codex', { kind: 'logo', backend: 'codex' }),
    ]
    expect(
      recommendContactAvatar(
        { templateId: 'security-auditor' },
        { contacts, templates: [template], random: () => 0.3 },
      ),
    ).toEqual({ id: ENGINEERING[17], theme: 'engineering' })
  })

  it('refuses a template it does not have', () => {
    expect(() =>
      recommendContactAvatar(
        { templateId: 'nobody' },
        { contacts: [], templates: [template] },
      ),
    ).toThrow(/没有这个岗位模板/)
  })
})
