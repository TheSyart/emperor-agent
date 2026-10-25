import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// DS-06 pixel baselines: the key screens of desktop/tests/visual are compared
// pixel by pixel (toHaveScreenshot) against PNGs committed under
// tests/visual/__baselines__/<area>/<screen>-<theme>.png. `npm run
// visual:baselines` compares, `npm run visual:baselines:update` regenerates.

const DESKTOP = join(new URL('.', import.meta.url).pathname, '../../..')
const MAX_TOTAL_BYTES = 15 * 1024 * 1024

interface BaselineScript {
  BASELINE_DIR: string
  declaredBaselines: () => { images: string[]; malformed: string[] }
  committedBaselines: () => string[]
}

async function load(): Promise<BaselineScript> {
  const url = pathToFileURL(join(DESKTOP, 'scripts/visual-baselines.mjs')).href
  return (await import(/* @vite-ignore */ url)) as BaselineScript
}

describe('pixel baselines (DS-06)', () => {
  it('keeps every baseline image under 15 MB in total (test 7)', async () => {
    const { BASELINE_DIR, committedBaselines } = await load()
    const files = committedBaselines()
    expect(files.length).toBeGreaterThan(0)
    const total = files.reduce(
      (sum, file) => sum + statSync(join(BASELINE_DIR, file)).size,
      0,
    )
    expect(total).toBeLessThan(MAX_TOTAL_BYTES)
  })

  // Started at 30 key screens (60 images); 0.2.1's UI fixes add a few
  // (BUG-05 video, BUG-06 folded sections). Still a curated set.
  it('has under 100 key images, one dark and one light of each screen', async () => {
    const files = (await load()).committedBaselines()
    expect(files.length).toBeGreaterThanOrEqual(50)
    expect(files.length).toBeLessThanOrEqual(100)
    for (const file of files) {
      expect(file).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+-(dark|light)\.png$/)
      const twin = file.endsWith('-dark.png')
        ? file.replace(/-dark\.png$/, '-light.png')
        : file.replace(/-light\.png$/, '-dark.png')
      expect(files, `${file} has no ${twin}`).toContain(twin)
    }
  })

  it('commits exactly the baselines the visual specs compare against', async () => {
    const { declaredBaselines, committedBaselines } = await load()
    const { images, malformed } = declaredBaselines()
    expect(
      malformed,
      "write expectBaseline(target, 'area', `screen-${theme}`)",
    ).toEqual([])
    expect(new Set(images).size, 'two calls share a baseline').toBe(
      images.length,
    )
    expect(committedBaselines()).toEqual(images)
  })

  it('names the two npm scripts the nightly CI job calls', () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'))
    expect(pkg.scripts['visual:baselines']).toBe(
      'node scripts/visual-baselines.mjs',
    )
    expect(pkg.scripts['visual:baselines:update']).toBe(
      'node scripts/visual-baselines.mjs --update',
    )
  })
})
