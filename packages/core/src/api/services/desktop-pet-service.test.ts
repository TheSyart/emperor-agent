import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreDesktopPetService } from './desktop-pet-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('CoreDesktopPetService (MIG-APP-003 / MIG-IPC-007)', () => {
  it('persists enabled preference and reports missing Electron dependency without throwing', async () => {
    const root = tmp('emperor-pet-service-missing-')
    const stateRoot = tmp('emperor-pet-service-missing-state-')
    const service = new CoreDesktopPetService(root, { stateRoot })

    const enabled = await service.setEnabled(true)

    expect(enabled).toMatchObject({ enabled: true, running: false, managedBy: 'CoreApi', available: false })
    expect(String(enabled.lastError)).toContain('Electron dependency missing')
    expect(readFileSync(join(stateRoot, 'emperor.local.json'), 'utf8')).toContain('"enabled": true')
    expect(existsSync(join(root, 'emperor.local.json'))).toBe(false)
    expect((await service.get()).enabled).toBe(true)

    const disabled = await service.setEnabled(false)

    expect(disabled).toMatchObject({ enabled: false, running: false, lastError: null })
    expect(existsSync(join(stateRoot, 'memory', 'desktop_pet', 'pid.json'))).toBe(false)
  })

  it('starts packaged pet commands, records pid state, and reports running payloads', async () => {
    const root = tmp('emperor-pet-service-packaged-')
    const stateRoot = tmp('emperor-pet-service-packaged-state-')
    const spawned: Array<{ cmd: string[]; cwd: string }> = []
    const service = new CoreDesktopPetService(root, {
      stateRoot,
      env: { EMPEROR_DESKTOP_PET_CMD: JSON.stringify(['/Applications/Emperor Agent.app/Contents/MacOS/Emperor Agent', '--pet-window']) },
      processAlive: (pid) => pid === 4321,
      spawn: (command, args, opts) => {
        spawned.push({ cmd: [command, ...args], cwd: String(opts.cwd) })
        return { pid: 4321, unref: () => {} }
      },
    })

    const payload = await service.setEnabled(true)

    expect(payload).toMatchObject({
      enabled: true,
      running: true,
      pid: 4321,
      lastError: null,
      installCommand: 'bundled with Emperor Agent.app',
      available: true,
    })
    expect(spawned[0]?.cmd).toEqual([
      '/Applications/Emperor Agent.app/Contents/MacOS/Emperor Agent',
      '--pet-window',
      '--root',
      root,
    ])
    expect(spawned[0]?.cwd).toBe(join(root, 'desktop-pet'))
    expect(JSON.parse(readFileSync(join(stateRoot, 'memory', 'desktop_pet', 'pid.json'), 'utf8')).pid).toBe(4321)
    expect(existsSync(join(root, 'memory', 'desktop_pet', 'pid.json'))).toBe(false)
  })

  it('runs mutation checks synchronously before toggling', () => {
    const service = new CoreDesktopPetService(tmp('emperor-pet-service-guard-'), {
      assertMutation: () => { throw new Error('blocked') },
    })

    expect(() => service.setEnabled(true)).toThrow('blocked')
  })
})
