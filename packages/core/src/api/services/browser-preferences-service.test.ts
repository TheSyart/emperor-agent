import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CoreBrowserPreferencesService } from './browser-preferences-service'

describe('CoreBrowserPreferencesService', () => {
  it('defaults to the system browser and persists a change across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-browser-prefs-'))
    const changed = vi.fn()
    const service = new CoreBrowserPreferencesService(root, { changed })
    expect(await service.get()).toEqual({
      enabled: true,
      linkTarget: 'system',
      showFullUrl: true,
      history: true,
    })
    await service.update({ linkTarget: 'builtin', showFullUrl: false })
    expect(changed).toHaveBeenCalledWith({
      enabled: true,
      linkTarget: 'builtin',
      showFullUrl: false,
      history: true,
    })
    const again = new CoreBrowserPreferencesService(root)
    expect((await again.get()).linkTarget).toBe('builtin')
    const onDisk = JSON.parse(
      await readFile(join(root, 'settings.json'), 'utf8'),
    )
    expect(onDisk.browser).toMatchObject({ linkTarget: 'builtin' })
  })

  it('is a guarded mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-browser-prefs-'))
    const service = new CoreBrowserPreferencesService(root, {
      assertMutation: () => {
        throw new Error('a card is pending')
      },
    })
    await expect(service.update({ enabled: false })).rejects.toThrow(
      /card is pending/,
    )
    expect((await service.get()).enabled).toBe(true)
  })
})
