import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverProviderModels, testModelEntry } from './model'

const g = globalThis as unknown as { window?: any; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('model API Core IPC (MIG-IPC-010)', () => {
  it('runs model tests through Core IPC when the bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return { ok: true, kind: 'text', sample: 'pong' }
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(testModelEntry('main', 'text', 'secondary')).resolves.toEqual({
      ok: true,
      kind: 'text',
      sample: 'pong',
    })

    expect(calls).toEqual([
      ['model.test', { entryName: 'main', kind: 'text', role: 'secondary' }],
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('discovers provider models through Core IPC', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return { ok: true, models: [{ id: 'deepseek-chat' }] }
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(
      discoverProviderModels({
        provider: 'deepseek',
        entryName: 'deepseek-work',
        apiBase: 'https://api.deepseek.com',
        apiKey: '***1234',
      }),
    ).resolves.toEqual({ ok: true, models: [{ id: 'deepseek-chat' }] })

    expect(calls).toEqual([
      [
        'model.discoverModels',
        {
          provider: 'deepseek',
          entryName: 'deepseek-work',
          apiBase: 'https://api.deepseek.com',
          apiKey: '***1234',
        },
      ],
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not fall back to HTTP model tests when the Core IPC bridge is unavailable', async () => {
    g.window = { emperor: {} }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(testModelEntry('main', 'text')).rejects.toThrow(
      'Core IPC bridge is unavailable; use the Electron desktop window.',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
