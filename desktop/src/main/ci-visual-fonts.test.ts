import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('keeps the baseline font distribution pinned, licensed and byte-identical', () => {
  const file = fileURLToPath(
    new URL(
      '../../tests/visual/fonts/noto-sans-sc/provenance.json',
      import.meta.url,
    ),
  )
  const root = dirname(file)
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
    package: string
    version: string
    license: string
    files: Record<string, string>
  }
  expect(manifest).toMatchObject({
    package: '@fontsource-variable/noto-sans-sc',
    version: '5.3.1',
    license: 'OFL-1.1',
  })
  expect(Object.keys(manifest.files).length).toBeGreaterThan(100)
  for (const [name, sha256] of Object.entries(manifest.files)) {
    expect(name).toMatch(/^(?:index\.css|LICENSE|files\/[a-z0-9.-]+\.woff2)$/)
    expect(
      createHash('sha256')
        .update(readFileSync(resolve(root, name)))
        .digest('hex'),
      name,
    ).toBe(sha256)
  }
  expect(readFileSync(resolve(root, 'LICENSE'), 'utf8')).toContain(
    'SIL OPEN FONT LICENSE Version 1.1',
  )
})
