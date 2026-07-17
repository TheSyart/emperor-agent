import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(__dirname, '../../styles/codex-v2.css'),
  'utf8',
)

describe('Composer visual contract', () => {
  it('renders the collapsed model trigger without a card border', () => {
    expect(css).toMatch(
      /\.model-button\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/s,
    )
    expect(css).toMatch(/\.model-provider-avatar\.bare\s*\{[^}]*border:\s*0/s)
  })

  it('keeps a subtle hover surface and visible keyboard focus', () => {
    expect(css).toContain('.model-button:hover:not(:disabled)')
    expect(css).toContain('.model-button:focus-visible')
  })

  it('renders monochrome Provider logos through Chromium-compatible masks', () => {
    expect(css).toMatch(
      /\.model-provider-mask\s*\{[^}]*-webkit-mask:\s*var\(--provider-icon\)/s,
    )
    expect(css).toMatch(
      /\.model-provider-mask\s*\{[^}]*mask:\s*var\(--provider-icon\)/s,
    )
  })
})
