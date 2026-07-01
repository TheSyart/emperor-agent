import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveOnboardingModelConfig, testModelEntry } from './model'

const g = globalThis as unknown as { window?: any; fetch?: unknown }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('model API Core IPC (MIG-IPC-010)', () => {
  it('runs model tests through Core IPC when the bridge is available', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return { ok: true, sample: 'pong' } } } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(testModelEntry('main', 'text', 'secondary')).resolves.toEqual({ ok: true, sample: 'pong' })

    expect(calls).toEqual([['model.test', { entryName: 'main', kind: 'text', role: 'secondary' }]])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('saves onboarding wizard settings through Core IPC', async () => {
    const calls: unknown[][] = []
    g.window = { emperor: { invokeCore: async (...args: unknown[]) => { calls.push(args); return { current: { model: 'deepseek-chat' } } } } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(saveOnboardingModelConfig({
      provider: 'deepseek',
      name: 'deepseek-work',
      label: '',
      apiKey: 'sk',
      apiBase: 'https://api.deepseek.com',
      mainModelId: 'deepseek-chat',
      secondaryModelId: 'deepseek-chat',
      maxTokens: 4096,
      temperature: 0.2,
      contextWindowTokens: 64000,
      reasoningEffort: null,
    })).resolves.toEqual({ current: { model: 'deepseek-chat' } })

    expect(calls).toEqual([['model.saveOnboardingConfig', {
      provider: 'deepseek',
      name: 'deepseek-work',
      label: '',
      apiKey: 'sk',
      apiBase: 'https://api.deepseek.com',
      mainModelId: 'deepseek-chat',
      secondaryModelId: 'deepseek-chat',
      maxTokens: 4096,
      temperature: 0.2,
      contextWindowTokens: 64000,
      reasoningEffort: null,
    }]])
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
