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

  it('returns the profile onboarding action after saving the first model config', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          if (args[0] === 'bootstrap') {
            return {
              app: 'Emperor Agent',
              modelConfig: { config: {} },
              profileOnboarding: {
                status: 'pending',
                sessionId: null,
                interactionId: null,
                attemptCount: 0,
                lastError: null,
                canStart: true,
                canSkip: true,
              },
            }
          }
          return {
            current: { model: 'fake-main', provider: 'fake' },
            config: {},
            profileOnboarding: {
              started: true,
              state: {
                status: 'in_progress',
                sessionId: 'default-session',
                interactionId: 'ask_profile',
                attemptCount: 1,
                lastError: null,
                canStart: false,
                canSkip: true,
              },
            },
          }
        },
      },
    }
    const boot = useBootstrap(() => {})
    await boot.loadBootstrap()

    const action = await boot.saveModelConfig({})

    expect(calls.at(-1)).toEqual(['model.saveConfig', { config: {} }])
    expect(action).toMatchObject({
      started: true,
      state: { sessionId: 'default-session', interactionId: 'ask_profile' },
    })
    expect(boot.boot.value?.profileOnboarding.status).toBe('in_progress')
  })
})
