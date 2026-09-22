// The trajectory model is framework-free renderer code: core only as types
// through the runtime contract, no Vue, no UI components, no legacy runtime
// projection, no node built-ins.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      return name === 'testing' ? [] : sources(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : []
  })
}

describe('trajectory model boundary', () => {
  const files = sources(__dirname)

  it('imports core only as types and stays framework-free', () => {
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const imports = text.match(/^import[^;]*?from '[^']+'/gms) ?? []
      for (const statement of imports) {
        const source = /from '([^']+)'$/.exec(statement)?.[1] ?? ''
        const where = relative(__dirname, file)
        if (source.startsWith('@emperor/core')) {
          expect(source, where).toBe('@emperor/core/runtime-contract')
          expect(statement.startsWith('import type'), where).toBe(true)
        }
        expect(source, where).not.toMatch(
          /^node:|^vue$|components\/|\/runtime\/|conversation\/store/,
        )
      }
    }
  })
})
