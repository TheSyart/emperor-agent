// The app icon and the extension icons are drawn from one vector source
// (BRD-02, scripts/render-brand-icons.mjs): RGBA PNGs of the named size.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const desktop = join(__dirname, '..', '..')

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngHeader(file: string) {
  const bytes = readFileSync(file)
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colourType: bytes[25],
  }
}

describe('brand icons', () => {
  it('has a 1024 RGBA app icon for electron-builder and the helpers', () => {
    expect(pngHeader(join(desktop, 'build/icon.png'))).toEqual({
      width: 1024,
      height: 1024,
      colourType: 6,
    })
  })

  it.each([16, 32, 48, 128])('has a %i px RGBA extension icon', (size) => {
    expect(
      pngHeader(join(desktop, `extension/icons/icon-${size}.png`)),
    ).toEqual({ width: size, height: size, colourType: 6 })
  })

  it('renders them from the app icon vector', () => {
    const script = readFileSync(
      join(desktop, 'scripts/render-brand-icons.mjs'),
      'utf8',
    )
    expect(script).toContain('assets/generated/emperor-app-icon.svg')
    expect(script).toContain('build/icon.png')
    expect(script).toContain('extension/icons/icon-')
  })
})
