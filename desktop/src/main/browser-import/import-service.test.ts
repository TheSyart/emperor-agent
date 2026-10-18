import { describe, expect, it, vi } from 'vitest'
import {
  ImportError,
  importBrowserData,
  listImportSources,
  type CookieToSet,
} from './import-service'
import type { CookieRecord, PasswordRecord } from './types'

function password(over: Partial<PasswordRecord> = {}): PasswordRecord {
  return {
    origin: 'https://mail.test',
    username: 'alice',
    password: 'pw',
    ...over,
  }
}
function cookie(over: Partial<CookieRecord> = {}): CookieRecord {
  return {
    hostKey: '.mail.test',
    name: 'SID',
    value: 'tok',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    ...over,
  }
}

/** A vault stand-in; no real key file or Keychain. */
function fakeVault(
  over: Partial<{
    available: boolean
    locked: boolean
    entries: Array<{
      bindings: Array<{ kind: string; origin?: string }>
      username?: string
    }>
  }> = {},
) {
  const saved: Array<{ origin: string; username?: string; password: string }> =
    []
  return {
    available: over.available ?? true,
    locked: over.locked ?? false,
    entries: () => over.entries ?? [],
    save: vi.fn(
      (draft: { bindings: any[]; username?: string; password: string }) => {
        saved.push({
          origin: draft.bindings[0].origin,
          username: draft.username,
          password: draft.password,
        })
        return { handleId: `h${saved.length}` }
      },
    ),
    saveMany: vi.fn(
      (
        drafts: Array<{ bindings: any[]; username?: string; password: string }>,
      ) => {
        for (const draft of drafts)
          saved.push({
            origin: draft.bindings[0].origin,
            username: draft.username,
            password: draft.password,
          })
        return drafts.map((_draft, index) => ({ handleId: `h${index}` }))
      },
    ),
    saved,
  }
}

function fakeSink() {
  const set = vi.fn(async (_cookie: CookieToSet) => {})
  const flush = vi.fn(async () => {})
  return { set, flush, make: vi.fn(async () => ({ set, flush })) }
}

describe('listImportSources', () => {
  it('reports each browser with running state and profiles', () => {
    const discover = vi.fn(() => [
      {
        browser: 'chrome' as const,
        name: 'Google Chrome',
        userDataDir: '/u/Chrome',
        installed: true,
        profiles: [{ dir: 'Default', name: 'Person 1' }],
      },
      {
        browser: 'edge' as const,
        name: 'Microsoft Edge',
        userDataDir: '/u/Edge',
        installed: false,
        profiles: [],
      },
    ])
    const detect = vi.fn((dir: string) =>
      dir === '/u/Chrome'
        ? { running: true as const, reason: 'running' as const }
        : { running: false as const, reason: 'no-lock' as const },
    )
    const sources = listImportSources({ discover, detect })
    expect(sources.browsers[0]).toEqual({
      browser: 'chrome',
      name: 'Google Chrome',
      installed: true,
      running: true,
      reason: 'running',
      profiles: [{ dir: 'Default', name: 'Person 1' }],
    })
    expect(sources.browsers[1].running).toBe(false)
    expect(sources.browsers[1].installed).toBe(false)
  })
})

describe('importBrowserData', () => {
  const notRunning = () => ({
    running: false as const,
    reason: 'no-lock' as const,
  })

  it('imports passwords, skipping duplicates and non-http realms', async () => {
    const vault = fakeVault({
      entries: [
        {
          bindings: [{ kind: 'origin', origin: 'https://mail.test' }],
          username: 'alice',
        },
      ],
    })
    const read = vi.fn(async () => ({
      passwords: [
        password({ origin: 'https://mail.test', username: 'alice' }), // dup → skip
        password({ origin: 'https://shop.test', username: 'bob' }), // new
        password({ origin: 'android://app', username: 'x' }), // non-http → skip
      ],
      cookies: [],
      counts: { passwords: 3, cookies: 0 },
    }))
    const result = await importBrowserData(
      {
        browser: 'chrome',
        profileDir: 'Default',
        passwords: true,
        cookies: false,
      },
      { read, detect: notRunning, vault },
    )
    expect(result).toEqual({ ok: true, passwords: 1, sites: 0 })
    expect(vault.saved).toEqual([
      { origin: 'https://shop.test', username: 'bob', password: 'pw' },
    ])
  })

  it('writes a thousand passwords to the vault in one save (MAIN-7)', async () => {
    const vault = fakeVault()
    const read = vi.fn(async () => ({
      passwords: Array.from({ length: 1000 }, (_v, index) =>
        password({ origin: `https://site${index}.test`, username: 'u' }),
      ),
      cookies: [],
      counts: { passwords: 1000, cookies: 0 },
    }))
    const result = await importBrowserData(
      {
        browser: 'chrome',
        profileDir: 'Default',
        passwords: true,
        cookies: false,
      },
      { read, detect: notRunning, vault },
    )
    expect(result).toMatchObject({ passwords: 1000 })
    expect(vault.saveMany).toHaveBeenCalledTimes(1)
    expect(vault.save).not.toHaveBeenCalled()
    expect(vault.saved).toHaveLength(1000)
  })

  it('writes cookies to the target profile, counting unique hosts, then flushes', async () => {
    const sink = fakeSink()
    const read = vi.fn(async () => ({
      passwords: [],
      cookies: [
        cookie({ hostKey: '.mail.test', name: 'A' }),
        cookie({ hostKey: 'mail.test', name: 'B' }), // same host → 1 site
        cookie({ hostKey: 'shop.test', name: 'C', secure: false }),
      ],
      counts: { passwords: 0, cookies: 3 },
    }))
    const result = await importBrowserData(
      {
        browser: 'chrome',
        profileDir: 'Default',
        passwords: false,
        cookies: true,
        targetProfileId: 'p_0123456789ab',
      },
      { read, detect: notRunning, cookieSink: sink.make },
    )
    expect(sink.make).toHaveBeenCalledWith('p_0123456789ab')
    expect(sink.set).toHaveBeenCalledTimes(3)
    expect(sink.flush).toHaveBeenCalledTimes(1)
    // A domain cookie keeps its leading dot as `domain`; url drops it.
    expect(sink.set.mock.calls[0][0]).toMatchObject({
      url: 'https://mail.test/',
      name: 'A',
      domain: '.mail.test',
      sameSite: 'lax',
    })
    expect(sink.set.mock.calls[2][0]).toMatchObject({
      url: 'http://shop.test/',
    })
    expect(result).toEqual({ ok: true, passwords: 0, sites: 2 })
  })

  it('refuses when the browser is still running', async () => {
    await expect(
      importBrowserData(
        {
          browser: 'chrome',
          profileDir: 'Default',
          passwords: true,
          cookies: false,
        },
        {
          detect: () => ({ running: true, reason: 'running' }),
          vault: fakeVault(),
        },
      ),
    ).rejects.toMatchObject({ reason: 'browser-running' })
  })

  it('refuses passwords when the vault is locked (does not read)', async () => {
    const read = vi.fn()
    await expect(
      importBrowserData(
        {
          browser: 'chrome',
          profileDir: 'Default',
          passwords: true,
          cookies: false,
        },
        { read, detect: notRunning, vault: fakeVault({ locked: true }) },
      ),
    ).rejects.toMatchObject({ reason: 'vault-locked' })
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses passwords when the vault is unavailable', async () => {
    await expect(
      importBrowserData(
        {
          browser: 'chrome',
          profileDir: 'Default',
          passwords: true,
          cookies: false,
        },
        { detect: notRunning, vault: fakeVault({ available: false }) },
      ),
    ).rejects.toMatchObject({ reason: 'vault-unavailable' })
  })

  it('requires a target profile when importing cookies', async () => {
    await expect(
      importBrowserData(
        {
          browser: 'chrome',
          profileDir: 'Default',
          passwords: false,
          cookies: true,
        },
        { detect: notRunning, cookieSink: fakeSink().make },
      ),
    ).rejects.toMatchObject({ reason: 'no-target-profile' })
  })

  it('refuses an unknown target profile before reading or writing anything', async () => {
    const read = vi.fn()
    const vault = fakeVault()
    const sink = fakeSink()
    const profileExists = vi.fn(() => false)
    await expect(
      importBrowserData(
        {
          browser: 'chrome',
          profileDir: 'Default',
          passwords: true,
          cookies: true,
          targetProfileId: 'p_0123456789ab',
        },
        {
          read,
          detect: notRunning,
          vault,
          cookieSink: sink.make,
          profileExists,
        },
      ),
    ).rejects.toMatchObject({ reason: 'no-target-profile' })
    expect(profileExists).toHaveBeenCalledWith('p_0123456789ab')
    expect(read).not.toHaveBeenCalled()
    expect(vault.save).not.toHaveBeenCalled()
    expect(sink.make).not.toHaveBeenCalled()
  })

  it('refuses when nothing is selected', async () => {
    await expect(
      importBrowserData(
        {
          browser: 'chrome',
          profileDir: 'Default',
          passwords: false,
          cookies: false,
        },
        { detect: notRunning },
      ),
    ).rejects.toBeInstanceOf(ImportError)
  })

  it('logs counts only, never values', async () => {
    const log = vi.fn()
    const sink = fakeSink()
    const read = vi.fn(async () => ({
      passwords: [password()],
      cookies: [cookie()],
      counts: { passwords: 1, cookies: 1 },
    }))
    await importBrowserData(
      {
        browser: 'chrome',
        profileDir: 'Default',
        passwords: true,
        cookies: true,
        targetProfileId: 'p_0123456789ab',
      },
      {
        read,
        detect: notRunning,
        vault: fakeVault(),
        cookieSink: sink.make,
        log,
      },
    )
    expect(log).toHaveBeenCalledWith('browser-import complete', {
      passwords: 1,
      sites: 1,
    })
    const logged = JSON.stringify(log.mock.calls)
    expect(logged).not.toContain('pw')
    expect(logged).not.toContain('tok')
  })
})
