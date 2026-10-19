import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainRoot = __dirname

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === 'test-fixtures' ? [] : sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  })
}

describe('system commands of the main process (SEC-04, MAIN-26)', () => {
  it('runs every external command it names from an absolute path', () => {
    // execFile('codesign', …) resolves through PATH, which another process
    // of this user can set (launchctl setenv): it would decide which
    // codesign vouches for a helper, or which security reads the Keychain.
    const call =
      /\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*(['"`])([^'"`]+)\1/g
    const bare: string[] = []
    let checked = 0
    for (const file of sources(mainRoot)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(call)) {
        checked++
        if (!match[2]!.startsWith('/'))
          bare.push(`${relative(mainRoot, file)}: ${match[2]}`)
      }
    }
    expect(bare).toEqual([])
    // The scan sees the literal call sites (security, ps); the helper
    // launcher's tools are constants (MACOS_TOOLS, macos-launcher.test.ts).
    expect(checked).toBeGreaterThanOrEqual(2)
  })
})
