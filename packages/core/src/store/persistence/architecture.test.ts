import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const coreSourceRoot = resolve(__dirname, '..', '..')

describe('persistence kernel architecture', () => {
  it('has one proven lock implementation instead of the unused legacy helper', () => {
    const coreIndex = readFileSync(resolve(coreSourceRoot, 'index.ts'), 'utf8')
    const syncJournal = readFileSync(
      resolve(__dirname, 'sync-journal.ts'),
      'utf8',
    )

    expect(coreIndex).not.toContain("export * from './store/file-lock'")
    expect(existsSync(resolve(coreSourceRoot, 'store/file-lock.ts'))).toBe(
      false,
    )
    expect(syncJournal).toContain('withPersistenceLockSync(')
  })

  it('keeps direct filesystem durability code inside the adapter', () => {
    for (const file of ['snapshot.ts', 'sync-snapshot.ts', 'sync-journal.ts']) {
      const source = readFileSync(resolve(__dirname, file), 'utf8')
      expect(source).not.toMatch(/from 'node:fs(?:\/promises)?'/)
    }
  })
})
