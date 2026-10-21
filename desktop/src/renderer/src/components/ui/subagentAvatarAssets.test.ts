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
