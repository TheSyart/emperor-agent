import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// SUB-30 · AGT-10 test 10: the portraits ship as small sheets; every frame
// still lies inside its sheet.
const DIR = new URL('../../assets/subagent-avatars/', import.meta.url).pathname

it('10 · the subagent portraits weigh under 1 MB together', () => {
  const sheets = readdirSync(DIR).filter((name) => name.endsWith('.webp'))
  expect(sheets).toHaveLength(4)
  const total = sheets.reduce(
    (sum, name) => sum + statSync(join(DIR, name)).size,
    0,
  )
  expect(total).toBeLessThan(1_000_000)
})

it('keeps every frame of frames.json inside a 448px sheet', () => {
  const frames = JSON.parse(readFileSync(join(DIR, 'frames.json'), 'utf8')) as {
    id: string
    rect: [number, number, number, number]
  }[]
  expect(frames).toHaveLength(36)
  for (const { id, rect } of frames) {
    const [x, y, w, h] = rect
    expect(x >= 0 && y >= 0 && w > 0 && h > 0, id).toBe(true)
    expect(x + w <= 448 && y + h <= 448, id).toBe(true)
    // Big enough for a 40px avatar on a 2x screen.
    expect(Math.min(w, h), id).toBeGreaterThanOrEqual(80)
  }
})

// UI-S13 · 1: the portraits have no backdrop: every sheet is a WebP with an
// alpha channel (VP8X with the alpha flag, and an ALPH chunk). Which pixels
// are clear is checked in the browser (tests/visual/subagent-avatars.spec.ts).
it('UI-S13 · 1 · every sheet carries an alpha channel', () => {
  const sheets = readdirSync(DIR).filter((name) => name.endsWith('.webp'))
  for (const name of sheets) {
    const bytes = readFileSync(join(DIR, name))
    expect(bytes.toString('ascii', 0, 4), name).toBe('RIFF')
    expect(bytes.toString('ascii', 8, 12), name).toBe('WEBP')
    expect(bytes.toString('ascii', 12, 16), name).toBe('VP8X')
    // VP8X flags: bit 4 = alpha.
    expect(bytes[20]! & 0x10, name).toBe(0x10)
    expect(bytes.includes(Buffer.from('ALPH')), name).toBe(true)
  }
})
