import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTACT_AVATAR_CELL,
  CONTACT_AVATAR_IDS,
  CONTACT_AVATAR_THEMES,
  CONTACT_AVATAR_THEME_LABELS,
  contactAvatarCell,
  contactAvatarTheme,
  loadContactAvatarManifest,
} from './contactAvatars'

// BRD-07: the contact avatar library — 15 repacked sheets of nine, located
// by id alone; the labels, themes and tints load with the picker.
const DIR = new URL('../../assets/contact-avatars/', import.meta.url).pathname
type Entry = {
  id: string
  sheet: string
  rect: [number, number, number, number]
  theme: string
  label: string
  tint: string
}
const manifest = JSON.parse(
  readFileSync(join(DIR, 'manifest.json'), 'utf8'),
) as Entry[]

describe('the sheets', () => {
  it('ships 15 sheets under 1.5 MB together', () => {
    const sheets = readdirSync(DIR).filter((name) => name.endsWith('.webp'))
    expect(sheets.sort()).toEqual(
      Array.from(
        { length: 15 },
        (_, i) => `AV-${String(i + 1).padStart(2, '0')}.webp`,
      ),
    )
    const total = sheets.reduce(
      (sum, name) => sum + statSync(join(DIR, name)).size,
      0,
    )
    expect(total).toBeLessThan(1_500_000)
  })

  it('gives every sheet an alpha channel (VP8X alpha flag and an ALPH chunk)', () => {
    for (const name of readdirSync(DIR).filter((n) => n.endsWith('.webp'))) {
      const bytes = readFileSync(join(DIR, name))
      expect(bytes.toString('ascii', 0, 4), name).toBe('RIFF')
      expect(bytes.toString('ascii', 12, 16), name).toBe('VP8X')
      expect(bytes[20]! & 0x10, name).toBe(0x10)
      expect(bytes.includes(Buffer.from('ALPH')), name).toBe(true)
    }
  })
})

describe('the manifest', () => {
  it('lists 135 unique ids in prompt order', () => {
    expect(manifest).toHaveLength(135)
    expect(new Set(manifest.map((e) => e.id)).size).toBe(135)
    expect(manifest.map((e) => e.id)).toEqual([...CONTACT_AVATAR_IDS])
  })

  it('uses only the library themes and gives every avatar a label', () => {
    for (const entry of manifest) {
      expect(CONTACT_AVATAR_THEMES, entry.id).toContain(entry.theme)
      expect(entry.label.trim().length, entry.id).toBeGreaterThan(0)
    }
  })

  it('agrees with the cell computed from the id alone', () => {
    for (const entry of manifest) {
      const cell = contactAvatarCell(entry.id)!
      const [x, y, w, h] = entry.rect
      expect(cell.x, entry.id).toBe(x)
      expect(cell.y, entry.id).toBe(y)
      expect(cell.size, entry.id).toBe(w)
      expect(h, entry.id).toBe(w)
      expect(cell.tint, entry.id).toBe(entry.tint)
      expect(cell.sheet, entry.id).toContain(entry.sheet)
    }
  })

  it('loads lazily with the same entries', async () => {
    expect(await loadContactAvatarManifest()).toEqual(manifest)
  })
})

describe('contactAvatarCell', () => {
  it('places AV-01-1 top left and AV-15-9 bottom right of their sheets', () => {
    expect(contactAvatarCell('AV-01-1')).toMatchObject({ x: 0, y: 0 })
    expect(contactAvatarCell('AV-15-9')).toMatchObject({
      x: CONTACT_AVATAR_CELL * 2,
      y: CONTACT_AVATAR_CELL * 2,
      size: CONTACT_AVATAR_CELL,
    })
  })

  it('reads row-major: the fourth portrait starts the second row', () => {
    expect(contactAvatarCell('AV-07-4')).toMatchObject({
      x: 0,
      y: CONTACT_AVATAR_CELL,
    })
  })

  it.each([
    '',
    'AV-00-1',
    'AV-16-1',
    'AV-01-0',
    'AV-1-1',
    'av-01-1',
    'AV-01-10',
  ])('rejects %j', (id) => {
    expect(contactAvatarCell(id)).toBeNull()
  })

  it('keeps the default avatars of the 18 role templates in the library', () => {
    const defaults = [
      'AV-01-1',
      'AV-01-2',
      'AV-01-3',
      'AV-01-4',
      'AV-01-5',
      'AV-01-7',
      'AV-03-1',
      'AV-03-2',
      'AV-04-1',
      'AV-04-2',
      'AV-04-3',
      'AV-04-4',
      'AV-04-5',
      'AV-05-1',
      'AV-05-2',
      'AV-05-3',
      'AV-05-4',
      'AV-05-5',
    ]
    for (const id of defaults) expect(contactAvatarCell(id), id).not.toBeNull()
  })
})

describe('contactAvatarTheme (GRP-04)', () => {
  it('knows every avatar’s theme from its id, as the manifest has it', () => {
    for (const entry of manifest)
      expect(contactAvatarTheme(entry.id), entry.id).toBe(entry.theme)
    expect(contactAvatarTheme('AV-16-1')).toBeNull()
  })

  it('names every theme in Chinese', () => {
    expect(Object.keys(CONTACT_AVATAR_THEME_LABELS).sort()).toEqual(
      [...CONTACT_AVATAR_THEMES].sort(),
    )
    expect(CONTACT_AVATAR_THEME_LABELS['court-military']).toBe('武将')
  })
})
