import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CoreBrowserPreferencesService } from './browser-preferences-service'

/** The renderer shows no session (KRN-01 view scope). */
const VIEW = { sessionId: null }

describe('CoreBrowserPreferencesService', () => {
  it('defaults to the system browser and persists a change across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-browser-prefs-'))
    const changed = vi.fn()
    const service = new CoreBrowserPreferencesService(root, { changed })
    expect(await service.get()).toEqual({
      linkTarget: 'system',
      localTarget: 'builtin',
      showFullUrl: true,
      history: true,
      downloadDirectory: null,
      askWhereToSave: false,
    })
    await service.update({ linkTarget: 'builtin', showFullUrl: false }, VIEW)
    expect(changed).toHaveBeenCalledWith({
      linkTarget: 'builtin',
      localTarget: 'builtin',
      showFullUrl: false,
      history: true,
      downloadDirectory: null,
      askWhereToSave: false,
    })
    await service.update({ localTarget: 'system' }, VIEW)
    expect((await service.get()).localTarget).toBe('system')
    const again = new CoreBrowserPreferencesService(root)
    expect((await again.get()).linkTarget).toBe('builtin')
    const onDisk = JSON.parse(
      await readFile(join(root, 'settings.json'), 'utf8'),
    )
    expect(onDisk.browser).toMatchObject({ linkTarget: 'builtin' })
  })

  it('keeps the download folder and the ask-first choice, and goes back to the system folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-browser-prefs-'))
    const changed = vi.fn()
    const service = new CoreBrowserPreferencesService(root, { changed })
    await service.update(
      {
        downloadDirectory: '/Users/me/Downloads/web',
        askWhereToSave: true,
      },
      VIEW,
    )
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        downloadDirectory: '/Users/me/Downloads/web',
        askWhereToSave: true,
      }),
    )
    const again = new CoreBrowserPreferencesService(root)
    expect(await again.get()).toMatchObject({
      downloadDirectory: '/Users/me/Downloads/web',
      askWhereToSave: true,
    })
    await again.update({ downloadDirectory: null }, VIEW)
    expect((await service.get()).downloadDirectory).toBeNull()
  })
})
