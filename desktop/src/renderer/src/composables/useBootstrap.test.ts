import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBootstrap } from './useBootstrap'

const g = globalThis as unknown as { window?: unknown; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('useBootstrap IPC bootstrap (MIG-IPC-004)', () => {
  it('loads bootstrap through Core IPC when the preload bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return {
            app: 'Emperor Agent',
            modelConfig: {
              config: { agents: { defaults: { provider: 'fake' } } },
            },
          }
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const boot = useBootstrap(() => {})

    await boot.loadBootstrap(true, 'session-1')

    expect(calls).toEqual([['bootstrap', { sessionId: 'session-1' }]])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(boot.boot.value?.app).toBe('Emperor Agent')
    expect(boot.modelDraftProvider.value).toBe('fake')
  })

  it('imports skill archives through Core IPC when the preload bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = {
      confirm: () => true,
      emperor: {
        getPathForFile: () => '/tmp/demo.zip',
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'skills.previewInstall')
            return {
              previewId: `preview_${'a'.repeat(24)}`,
              digest: 'b'.repeat(64),
              candidates: [
                {
                  candidateId: `candidate_${'c'.repeat(20)}`,
                  name: 'demo-skill',
                  valid: true,
                  errors: [],
                  scripts: [],
                  externalCommands: [],
                },
              ],
            }
          if (args[0] === 'skills.confirmInstall') return { name: 'demo-skill' }
          return { app: 'Emperor Agent' }
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const boot = useBootstrap(() => {})
    const data = new FormData()
    data.append(
      'file',
      new File(['zip-bytes'], 'demo.zip', { type: 'application/zip' }),
    )

    await expect(boot.importSkill(data)).resolves.toBe('demo-skill')

    expect(calls[0]).toEqual([
      'skills.previewInstall',
      { source: { kind: 'local', path: '/tmp/demo.zip' } },
    ])
    expect(calls[1]?.[0]).toBe('skills.confirmInstall')
    expect(calls[1]?.[1]).toMatchObject({ permissionConfirmed: true })
    expect(calls.at(-1)).toEqual(['bootstrap', { sessionId: null }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
