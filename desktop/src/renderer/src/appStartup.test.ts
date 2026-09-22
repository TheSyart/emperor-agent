import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { runInitialStartup } from './appStartup'

describe('runInitialStartup', () => {
  it('routes session-load failures into bootstrap error handling instead of leaving the app loading', async () => {
    const loadBootstrap = vi.fn(async () => undefined)
    const switchSession = vi.fn()
    const restoreRuntimeState = vi.fn()
    const connectSocket = vi.fn()

    await runInitialStartup({
      sessionStore: {
        activeId: ref(''),
        load: vi.fn(async () => {
          throw new Error(
            'Core IPC bridge is unavailable; use the Electron desktop window.',
          )
        }),
        backendSessionId: () => '',
        isDraftSessionId: () => false,
      },
      bootstrap: {
        boot: ref(null),
        error: ref(
          'Core IPC bridge is unavailable; use the Electron desktop window.',
        ),
        loadBootstrap,
      },
      switchSession,
      restoreRuntimeState,
      connectSocket,
    })

    expect(loadBootstrap).toHaveBeenCalledWith(true, '')
    expect(switchSession).not.toHaveBeenCalled()
    expect(restoreRuntimeState).not.toHaveBeenCalled()
    expect(connectSocket).not.toHaveBeenCalled()
  })
})
