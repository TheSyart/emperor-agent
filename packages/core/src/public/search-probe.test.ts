import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { searchProbe } from './search-probe'

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'emperor-probe-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'smoke.ts'),
    "export const emperorSmokeNeedle = 'ready'\n",
  )
  writeFileSync(join(root, 'README.md'), 'nothing here\n')
  return root
}

const missingRg = join(tmpdir(), 'emperor-no-such-dir', 'rg-missing')

describe('searchProbe', () => {
  for (const ripgrepPath of [undefined, missingRg]) {
    const label =
      ripgrepPath === undefined ? 'PATH rg or fallback' : 'forced JS fallback'
    it(`globs and greps workspace-relative paths (${label})`, async () => {
      const root = workspace()
      const request = ripgrepPath === undefined ? {} : { ripgrepPath }
      const glob = await searchProbe(root, {
        kind: 'glob',
        pattern: '**/*.ts',
        ...request,
      })
      expect(glob.split('\n')).toEqual(['src/smoke.ts'])
      const grep = await searchProbe(root, {
        kind: 'grep',
        pattern: 'emperorSmokeNeedle',
        ...request,
      })
      expect(grep.split('\n')).toContain('src/smoke.ts')
      expect(grep.startsWith('Found 1 match')).toBe(true)
      expect(
        await searchProbe(root, {
          kind: 'grep',
          pattern: 'absent-needle',
          ...request,
        }),
      ).toBe('No matches found')
    })
  }

  it('reports a tool failure as an [ERR] line', async () => {
    const root = workspace()
    expect(await searchProbe(root, { kind: 'glob', pattern: '   ' })).toMatch(
      /^\[ERR\] pattern must be a non-empty string/,
    )
  })
})
