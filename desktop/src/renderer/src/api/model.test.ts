import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activateModelEntry,
  deleteModelEntry,
  discoverProviderModels,
  resolveModelProfilePreview,
  saveModelEntry,
  saveModelPolicy,
  setModelReasoningEffort,
  testModelEntry,
} from './model'

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

    await expect(testModelEntry('entry-1', 'text')).resolves.toEqual({
      ok: true,
      kind: 'text',
      sample: 'pong',
    })

    expect(calls).toEqual([
      ['model.test', { entryId: 'entry-1', kind: 'text' }],
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
        protocol: 'openai',
        entryId: 'deepseek-work',
        apiBase: 'https://api.deepseek.com',
        apiKey: '***1234',
      }),
    ).resolves.toEqual({ ok: true, models: [{ id: 'deepseek-chat' }] })

    expect(calls).toEqual([
      [
        'model.discoverModels',
        {
          provider: 'deepseek',
          protocol: 'openai',
          entryId: 'deepseek-work',
          apiBase: 'https://api.deepseek.com',
          apiKey: '***1234',
        },
      ],
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses the typed model CRUD operations', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return { schemaVersion: 2, activeModelId: 'entry-1', models: [] }
        },
      },
    }

    await saveModelEntry({
      entryId: 'entry-1',
      provider: 'openai',
      protocol: 'openai',
      modelId: 'gpt-5.2',
      apiBase: 'https://api.openai.com/v1',
      contextWindowTokens: 128_000,
      maxTokens: 16_000,
      reasoningEffort: 'high',
    })
    await saveModelPolicy({
      fallback: {
        enabled: false,
        entryId: null,
        triggerOn: ['rate_limit'],
      },
      cost: { maxUsdPerAgentTurn: null },
    })
    await activateModelEntry('entry-1')
    await setModelReasoningEffort('entry-1', 'xhigh')
    await resolveModelProfilePreview({
      provider: 'openai',
      protocol: 'openai',
      modelId: 'gpt-5.2',
      contextWindowTokens: 128_000,
      maxTokens: 16_000,
    })
    await deleteModelEntry('entry-1')

    expect(calls).toEqual([
      ['model.saveEntry', expect.objectContaining({ entryId: 'entry-1' })],
      [
        'model.savePolicy',
        {
          fallback: {
            enabled: false,
            entryId: null,
            triggerOn: ['rate_limit'],
          },
          cost: { maxUsdPerAgentTurn: null },
        },
      ],
      ['model.activate', { entryId: 'entry-1' }],
      [
        'model.setReasoningEffort',
        { entryId: 'entry-1', reasoningEffort: 'xhigh' },
      ],
      [
        'model.resolveProfile',
        {
          provider: 'openai',
          protocol: 'openai',
          modelId: 'gpt-5.2',
          contextWindowTokens: 128_000,
          maxTokens: 16_000,
        },
      ],
      ['model.deleteEntry', { entryId: 'entry-1' }],
    ])
  })

  it('does not fall back to HTTP model tests when the Core IPC bridge is unavailable', async () => {
    g.window = { emperor: {} }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(testModelEntry('entry-1', 'text')).rejects.toThrow(
      'Core IPC bridge is unavailable; use the Electron desktop window.',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
