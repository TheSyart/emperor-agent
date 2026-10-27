import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreDesktopPetService } from './desktop-pet-service'

/** The renderer shows no session (KRN-01 view scope). */
const VIEW = { sessionId: null }

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('CoreDesktopPetService', () => {
  it('persists enabled preference without claiming window runtime state', async () => {
    const root = tmp('emperor-pet-service-')
    const stateRoot = tmp('emperor-pet-service-state-')
    const service = new CoreDesktopPetService(root, { stateRoot })

    const enabled = await service.setEnabled(true, VIEW)

    expect(enabled).toMatchObject({
      enabled: true,
      running: false,
      managedBy: 'Electron main process',
      available: true,
    })
    expect(enabled.pid).toBeNull()
    expect(enabled.lastError).toBeNull()
    expect(enabled.installCommand).toBe('')
    expect(readFileSync(join(stateRoot, 'settings.json'), 'utf8')).toContain(
      '"enabled": true',
    )
    expect((await service.get()).enabled).toBe(true)
    expect(
      existsSync(join(stateRoot, 'memory', 'desktop_pet', 'state.json')),
    ).toBe(false)

    const disabled = await service.setEnabled(false, VIEW)

    expect(disabled).toMatchObject({
      enabled: false,
      running: false,
      lastError: null,
    })
    expect(readFileSync(join(stateRoot, 'settings.json'), 'utf8')).toContain(
      '"enabled": false',
    )
  })

  it('keeps the outfit the pet wears: everyday by default, then the one picked (BRD-04)', async () => {
    const root = tmp('emperor-pet-outfit-')
    const stateRoot = tmp('emperor-pet-outfit-state-')
    const service = new CoreDesktopPetService(root, { stateRoot })

    expect((await service.get()).outfit).toBe('daily')
    expect((await service.setOutfit('robe', VIEW)).outfit).toBe('robe')
    expect((await service.get()).outfit).toBe('robe')
    // Turning the pet on or off keeps its outfit.
    await service.setEnabled(true, VIEW)
    expect((await service.get()).outfit).toBe('robe')
    expect((await service.setOutfit('original', VIEW)).outfit).toBe('original')
    expect(readFileSync(join(stateRoot, 'settings.json'), 'utf8')).toContain(
      '"outfit": "original"',
    )
  })

  it('reads an outfit it does not know as everyday', async () => {
    const stateRoot = tmp('emperor-pet-outfit-bad-')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(stateRoot, 'settings.json'),
      JSON.stringify({ desktopPet: { enabled: true, outfit: 'penguin' } }),
    )
    const service = new CoreDesktopPetService(stateRoot, { stateRoot })
    expect(await service.get()).toMatchObject({
      enabled: true,
      outfit: 'daily',
    })
  })
})
