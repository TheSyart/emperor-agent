/**
 * The contact avatar library (BRD-07): 135 Q-version portraits in the
 * mascot's style, 15 sheets of nine. assets/generated/contact-avatars/
 * slice_sheets.py repacks every sheet into a regular 3x3 grid of 192px
 * cells, so an id alone (AV-07-4: sheet 7, fourth portrait, row-major)
 * locates its cell and tint without the manifest. The manifest adds the
 * labels and themes the picker shows, and loads with it.
 */
import av01 from '../../assets/contact-avatars/AV-01.webp'
import av02 from '../../assets/contact-avatars/AV-02.webp'
import av03 from '../../assets/contact-avatars/AV-03.webp'
import av04 from '../../assets/contact-avatars/AV-04.webp'
import av05 from '../../assets/contact-avatars/AV-05.webp'
import av06 from '../../assets/contact-avatars/AV-06.webp'
import av07 from '../../assets/contact-avatars/AV-07.webp'
import av08 from '../../assets/contact-avatars/AV-08.webp'
import av09 from '../../assets/contact-avatars/AV-09.webp'
import av10 from '../../assets/contact-avatars/AV-10.webp'
import av11 from '../../assets/contact-avatars/AV-11.webp'
import av12 from '../../assets/contact-avatars/AV-12.webp'
import av13 from '../../assets/contact-avatars/AV-13.webp'
import av14 from '../../assets/contact-avatars/AV-14.webp'
import av15 from '../../assets/contact-avatars/AV-15.webp'

const SHEETS = [
  av01,
  av02,
  av03,
  av04,
  av05,
  av06,
  av07,
  av08,
  av09,
  av10,
  av11,
  av12,
  av13,
  av14,
  av15,
]

/** Cell edge in sheet pixels (the sheets are three cells square). */
export const CONTACT_AVATAR_CELL = 192

/** Must match slice_sheets.py, which writes the same tint into the manifest. */
const TINTS = ['#E8DEC8', '#D6E2EC', '#E0D8EC', '#ECDAD0', '#D6E8DC', '#F0E4C8']

export const CONTACT_AVATAR_THEMES = [
  'engineering',
  'design',
  'content',
  'product',
  'court-civil',
  'court-military',
  'court-life',
  'court-modern',
  'animals',
  'robots',
  'people',
  'whimsy',
] as const
export type ContactAvatarTheme = (typeof CONTACT_AVATAR_THEMES)[number]

/** The picker's theme names (docs/design/agent-contacts.md › 头像). */
export const CONTACT_AVATAR_THEME_LABELS: Readonly<
  Record<ContactAvatarTheme, string>
> = {
  engineering: '工程',
  design: '设计',
  content: '内容',
  product: '产品',
  'court-civil': '文臣',
  'court-military': '武将',
  'court-life': '宫廷',
  'court-modern': '混搭',
  animals: '动物',
  robots: '机器人',
  people: '人物',
  whimsy: '奇想',
}

/** The theme of each sheet, AV-01 … AV-15 (avatar-prompts.md §2). */
const SHEET_THEMES: readonly ContactAvatarTheme[] = [
  'engineering',
  'engineering',
  'design',
  'content',
  'product',
  'court-civil',
  'court-military',
  'court-life',
  'court-modern',
  'animals',
  'animals',
  'robots',
  'people',
  'people',
  'whimsy',
]

const ID = /^AV-(0[1-9]|1[0-5])-([1-9])$/

/** Every library id in prompt order: AV-01-1 … AV-15-9. */
export const CONTACT_AVATAR_IDS: readonly string[] = SHEETS.flatMap((_, s) =>
  Array.from(
    { length: 9 },
    (_, k) => `AV-${String(s + 1).padStart(2, '0')}-${k + 1}`,
  ),
)

export interface ContactAvatarCell {
  id: string
  sheet: string
  x: number
  y: number
  size: number
  tint: string
}

export interface ContactAvatarEntry {
  id: string
  sheet: string
  rect: [number, number, number, number]
  theme: ContactAvatarTheme
  label: string
  tint: string
}

/** Where a library avatar sits, or null for anything that is not an id. */
export function contactAvatarCell(id: string): ContactAvatarCell | null {
  const match = ID.exec(id)
  if (!match) return null
  const sheet = Number(match[1])
  const index = Number(match[2]) - 1
  return {
    id,
    sheet: SHEETS[sheet - 1]!,
    x: (index % 3) * CONTACT_AVATAR_CELL,
    y: Math.floor(index / 3) * CONTACT_AVATAR_CELL,
    size: CONTACT_AVATAR_CELL,
    tint: TINTS[(sheet + index + 1) % TINTS.length]!,
  }
}

/** A library avatar's theme from its id alone (null: not a library id). */
export function contactAvatarTheme(id: string): ContactAvatarTheme | null {
  const match = ID.exec(id)
  return match ? (SHEET_THEMES[Number(match[1]) - 1] ?? null) : null
}

/** The labels and themes, for the picker; kept out of the startup bundle. */
export async function loadContactAvatarManifest(): Promise<
  ContactAvatarEntry[]
> {
  const module = await import('../../assets/contact-avatars/manifest.json')
  return module.default as ContactAvatarEntry[]
}
