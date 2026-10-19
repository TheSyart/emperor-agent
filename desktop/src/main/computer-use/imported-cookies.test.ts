import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CookieToSet } from '../browser-import/import-service'
import { LocalSecretStore } from '../local-secret-store'
import {
  IMPORTED_COOKIES_FILE,
  ImportedCookieStore,
  type CookieSessionLike,
} from './imported-cookies'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 9, 19) // ms
const PROFILE = 'p_0123456789ab'
const OTHER = 'p_ba9876543210'

function cookie(over: Partial<CookieToSet> = {}): CookieToSet {
  return {
    url: 'https://mail.test/',
    name: 'SID',
    value: 'tok-secret-1',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    domain: '.mail.test',
    expirationDate: NOW / 1000 + 86_400,
    ...over,
  }
}

function fakeSession() {
  const set = vi.fn(async (_details: Record<string, unknown>) => undefined)
  return { set, session: { cookies: { set } } as CookieSessionLike }
}

function setup(options: { failExclusion?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'emperor-imported-cookies-'))
  roots.push(root)
  const storage = new LocalSecretStore({
    keyPath: join(root, 'computer-use', 'secrets', 'local.key'),
  })
  const excluded: string[] = []
  const logs: string[] = []
  const profilesRoot = join(root, 'browser', 'profiles')
  const store = new ImportedCookieStore({
    profilesRoot,
    storage,
    now: () => NOW,
    excludeFromBackup: async (path) => {
      excluded.push(path)
      if (options.failExclusion) throw new Error('tmutil failed')
    },
    log: (message) => logs.push(message),
  })
  return { root, profilesRoot, storage, store, excluded, logs }
}

describe('imported cookies (SEC-10, MAIN-4)', () => {
  it('keeps imported cookies only sealed on disk and sets them as session cookies', async () => {
    const t = setup()
    const { set, session } = fakeSession()
    const sink = t.store.sink(PROFILE, session)
    await sink.set(cookie())
    await sink.set(cookie({ name: 'pref', value: 'dark', httpOnly: false }))
    await sink.flush()
    // In memory: no expiry, so Chromium never writes them to `Cookies`.
    expect(set).toHaveBeenCalledTimes(2)
    for (const [details] of set.mock.calls)
      expect(details).not.toHaveProperty('expirationDate')
    expect(set.mock.calls[0]![0]).toMatchObject({
      url: 'https://mail.test/',
      name: 'SID',
      value: 'tok-secret-1',
      domain: '.mail.test',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    })
    const directory = join(t.profilesRoot, PROFILE)
    const file = join(directory, IMPORTED_COOKIES_FILE)
    const bytes = readFileSync(file)
    expect(bytes.subarray(0, 3).toString('ascii')).toBe('el1')
    expect(bytes.includes('tok-secret-1')).toBe(false)
    expect(bytes.includes('mail.test')).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    // The profile folder stays out of Time Machine.
    expect(t.excluded).toEqual([directory])
    expect(t.store.load(PROFILE).map((item) => item.value)).toEqual([
      'tok-secret-1',
      'dark',
    ])
  })

  it('keeps only cookies Electron accepted, and merges a second import', async () => {
    const t = setup()
    const { set, session } = fakeSession()
    set.mockImplementationOnce(async () => {
      throw new Error('invalid cookie')
    })
    const first = t.store.sink(PROFILE, session)
    await expect(first.set(cookie({ name: 'bad' }))).rejects.toThrow()
    await first.set(cookie({ name: 'A', value: 'a1' }))
    await first.set(cookie({ name: 'B', value: 'b1' }))
    await first.flush()
    const second = t.store.sink(PROFILE, session)
    await second.set(cookie({ name: 'A', value: 'a2' }))
    await second.set(cookie({ name: 'C', value: 'c1' }))
    await second.flush()
    expect(
      t.store
        .load(PROFILE)
        .map((item) => `${item.name}=${item.value}`)
        .sort(),
    ).toEqual(['A=a2', 'B=b1', 'C=c1'])
  })

  it('sets the sealed cookies into a profile session once per run, skipping expired ones', async () => {
    const t = setup()
    await t.store.save(PROFILE, [
      cookie({ name: 'live', value: 'v1' }),
      cookie({ name: 'gone', value: 'v0', expirationDate: NOW / 1000 - 1 }),
      cookie({ name: 'session', value: 'v2', expirationDate: undefined }),
    ])
    const { set, session } = fakeSession()
    // Two tabs of the same profile opening at once share one injection.
    await Promise.all([
      t.store.prepare(PROFILE, session),
      t.store.prepare(PROFILE, session),
    ])
    expect(set.mock.calls.map(([details]) => details.name).sort()).toEqual([
      'live',
      'session',
    ])
    for (const [details] of set.mock.calls)
      expect(details).not.toHaveProperty('expirationDate')
    await t.store.prepare(PROFILE, session)
    expect(set).toHaveBeenCalledTimes(2)
    expect(t.excluded).toEqual([join(t.profilesRoot, PROFILE)])
  })

  it('opens a file only for the profile it was sealed for', async () => {
    const t = setup()
    await t.store.save(PROFILE, [cookie()])
    mkdirSync(join(t.profilesRoot, OTHER), { recursive: true })
    copyFileSync(
      join(t.profilesRoot, PROFILE, IMPORTED_COOKIES_FILE),
      join(t.profilesRoot, OTHER, IMPORTED_COOKIES_FILE),
    )
    expect(t.store.load(OTHER)).toEqual([])
    const { set, session } = fakeSession()
    await t.store.prepare(OTHER, session)
    expect(set).not.toHaveBeenCalled()
    expect(t.logs.join('\n')).not.toContain('tok-secret-1')
  })

  it('forgets the imported cookies when the profile is cleared', async () => {
    const t = setup()
    await t.store.save(PROFILE, [cookie()])
    const file = join(t.profilesRoot, PROFILE, IMPORTED_COOKIES_FILE)
    expect(existsSync(file)).toBe(true)
    const { set, session } = fakeSession()
    await t.store.cleared(PROFILE, session)
    expect(existsSync(file)).toBe(false)
    await t.store.prepare(PROFILE, session)
    expect(set).not.toHaveBeenCalled()
  })

  it('still opens the profile when Time Machine exclusion fails', async () => {
    const t = setup({ failExclusion: true })
    await t.store.save(PROFILE, [cookie()])
    const { set, session } = fakeSession()
    await t.store.prepare(PROFILE, session)
    expect(set).toHaveBeenCalledTimes(1)
    expect(t.logs.some((line) => line.includes('Time Machine'))).toBe(true)
  })

  it('tries again after a profile could not be prepared', async () => {
    const t = setup()
    await t.store.save(PROFILE, [cookie()])
    const { set, session } = fakeSession()
    // The folder cannot be made: a file stands where it should be.
    const blocked = new ImportedCookieStore({
      profilesRoot: join(t.root, 'not-a-folder'),
      storage: t.storage,
      excludeFromBackup: async () => undefined,
    })
    writeFileSync(join(t.root, 'not-a-folder'), 'x')
    await expect(blocked.prepare(PROFILE, session)).rejects.toThrow()
    rmSync(join(t.root, 'not-a-folder'))
    await blocked.prepare(PROFILE, session)
    expect(set).not.toHaveBeenCalled() // nothing imported under that root
    await expect(blocked.prepare(PROFILE, session)).resolves.toBeUndefined()
  })

  it('refuses a profile id that is not Emperor’s', async () => {
    const t = setup()
    expect(() => t.store.load('../../etc')).toThrow(/profile/)
    await expect(t.store.save('p_x', [cookie()])).rejects.toThrow(/profile/)
  })
})
