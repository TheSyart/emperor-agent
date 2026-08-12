import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreDesktopPetService } from './desktop-pet-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('CoreDesktopPetService', () => {
  it('persists enabled preference without claiming window runtime state', async () => {
    const root = tmp('emperor-pet-service-')
    const stateRoot = tmp('emperor-pet-service-state-')
    const service = new CoreDesktopPetService(root, { stateRoot })

    const enabled = await service.setEnabled(true)

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

    const disabled = await service.setEnabled(false)

    expect(disabled).toMatchObject({
      enabled: false,
      running: false,
      lastError: null,
    })
    expect(readFileSync(join(stateRoot, 'settings.json'), 'utf8')).toContain(
      '"enabled": false',
    )
  })

  it('runs mutation checks synchronously before toggling', () => {
    const service = new CoreDesktopPetService(
      tmp('emperor-pet-service-guard-'),
      {
        assertMutation: () => {
          throw new Error('blocked')
        },
      },
    )

    expect(() => service.setEnabled(true)).toThrow('blocked')
  })
})
