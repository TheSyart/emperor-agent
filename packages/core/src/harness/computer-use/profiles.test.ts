import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_PROFILES_FILE,
  BrowserProfileStore,
  MAX_BROWSER_PROFILES,
  PROFILE_ID_PATTERN,
} from './profiles'

const root = () => mkdtempSync(join(tmpdir(), 'emperor-cu-profiles-'))

describe('browser profile store', () => {
  it('creates profiles with generated ids, persists them 0600 and records use', () => {
    const dir = root()
    let now = new Date('2026-09-24T01:00:00.000Z')
    const store = new BrowserProfileStore(dir, () => now)
    expect(store.list()).toEqual([])
    const work = store.create('  工作   账号 ')
    expect(work.name).toBe('工作 账号')
    expect(work.profileId).toMatch(PROFILE_ID_PATTERN)
    now = new Date('2026-09-24T02:00:00.000Z')
    store.touch(work.profileId)
    const path = join(dir, BROWSER_PROFILES_FILE)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const reread = new BrowserProfileStore(dir)
    expect(reread.get(work.profileId)).toEqual({
      ...work,
      lastUsedAt: '2026-09-24T02:00:00.000Z',
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1)
  })

  it('rejects duplicate or empty names, renames, removes and caps the count', () => {
    const store = new BrowserProfileStore(root())
    const a = store.create('A')
    expect(() => store.create('A')).toThrow(/exists/)
    expect(() => store.create('   ')).toThrow(/1–60/)
    expect(() => store.create('x'.repeat(61))).toThrow(/1–60/)
    expect(store.rename(a.profileId, 'B').name).toBe('B')
    expect(() => store.rename('p_000000000000', 'C')).toThrow(/no profile/)
    expect(store.remove(a.profileId)).toBe(true)
    expect(store.remove(a.profileId)).toBe(false)
    for (let index = 0; index < MAX_BROWSER_PROFILES; index += 1)
      store.create(`P${index}`)
    expect(() => store.create('one more')).toThrow(/at most/)
  })

  it('reads a corrupt or tampered file as empty instead of trusting it', () => {
    const dir = root()
    writeFileSync(
      join(dir, BROWSER_PROFILES_FILE),
      JSON.stringify({
        schemaVersion: 1,
        profiles: [{ profileId: '../../etc', name: 'x', createdAt: 'now' }],
      }),
    )
    expect(new BrowserProfileStore(dir).list()).toEqual([])
  })
})
