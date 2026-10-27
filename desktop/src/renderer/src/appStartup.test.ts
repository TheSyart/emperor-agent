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
            '无法连接 Emperor 核心：请在 Emperor 桌面窗口中打开。',
          )
        }),
        backendSessionId: () => '',
        isDraftSessionId: () => false,
      },
      bootstrap: {
        boot: ref(null),
        error: ref('无法连接 Emperor 核心：请在 Emperor 桌面窗口中打开。'),
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

  it('MOD-01 10 · lands in the saved mode before the first session opens', async () => {
    const order: string[] = []
    const activeId = ref('')
    const switchSession = vi.fn((id: string) => order.push(`switch:${id}`))
    await runInitialStartup({
      sessionStore: {
        activeId,
        load: vi.fn(async () => {
          order.push('sessions')
          activeId.value = 'chat-recent'
        }),
        backendSessionId: () => activeId.value,
        isDraftSessionId: () => false,
      },
      bootstrap: {
        boot: ref(null),
        error: ref(''),
        loadBootstrap: vi.fn(async (_loading?: boolean, id?: string) => {
          order.push(`bootstrap:${id}`)
        }),
      },
      switchSession,
      restoreRuntimeState: vi.fn(),
      connectSocket: vi.fn(),
      landInAppMode: vi.fn(async () => {
        order.push('land')
        activeId.value = 'build-last'
      }),
    })
    expect(order).toEqual([
      'sessions',
      'land',
      'switch:build-last',
      'bootstrap:build-last',
    ])
  })
})
