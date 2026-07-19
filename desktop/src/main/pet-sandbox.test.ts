import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mainSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
const preloadSource = readFileSync(
  resolve(__dirname, '..', 'pet', 'preload.js'),
  'utf8',
)

describe('desktop pet renderer sandbox', () => {
  it('uses an explicit sandbox and trusted app protocol resources', () => {
    expect(mainSource).toMatch(
      /createPetWindow[\s\S]*?webPreferences:\s*\{[\s\S]*?sandbox:\s*true/,
    )
    expect(mainSource).toContain("win.loadURL('app://pet/renderer.html')")
    expect(mainSource).toContain("'app://pet-assets/'")
  })

  it('keeps filesystem and the general Core bridge out of pet preload', () => {
    expect(preloadSource).not.toMatch(
      /require\(['"](?:node:)?(?:fs|path)['"]\)/,
    )
    expect(preloadSource).not.toContain('EMPEROR_AGENT_ROOT')
    expect(preloadSource).not.toContain('emperor:core:bootstrap')
    expect(preloadSource).not.toContain('emperor:pet:close')
    expect(preloadSource).toContain('emperor:pet:renderer-bootstrap')
    expect(preloadSource).toContain('emperor:pet:renderer-close')
  })
})
