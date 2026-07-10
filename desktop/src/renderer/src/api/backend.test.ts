import { describe, it, expect, afterEach } from 'vitest'
import { hasCoreBridge, invokeCore, onCoreEvent, openPath } from './backend'

const g = globalThis as unknown as { window?: unknown }

afterEach(() => {
  delete g.window
})

describe('with an injected Core IPC bridge', () => {
  it('reports bridge availability from the preload surface', () => {
    g.window = { emperor: {} }
    expect(hasCoreBridge()).toBe(false)

    g.window = { emperor: { invokeCore: async () => ({ ok: true }) } }
    expect(hasCoreBridge()).toBe(true)
  })

  it('delegates invokeCore to the preload bridge', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return { ok: true }
        },
      },
    }

    await expect(invokeCore('bootstrap', { sessionId: 's1' })).resolves.toEqual(
      { ok: true },
    )
    expect(calls).toEqual([['bootstrap', { sessionId: 's1' }]])
  })

  it('throws safe Core IPC errors instead of returning them as successful payloads', async () => {
    g.window = {
      emperor: {
        invokeCore: async () => ({
          ok: false,
          error: { message: 'Internal error', errorId: 'ipc_abc123' },
        }),
      },
    }

    await expect(
      invokeCore('model.test', { entryName: 'main' }),
    ).rejects.toMatchObject({
      message: 'Internal error',
      errorId: 'ipc_abc123',
    })
  })

  it('preserves safe Core IPC error codes and actions', async () => {
    g.window = {
      emperor: {
        invokeCore: async () => ({
          ok: false,
          error: {
            message: '还没有可用模型，请先配置模型。',
            code: 'model_configuration_required',
            action: 'open_model_settings',
          },
        }),
      },
    }

    await expect(
      invokeCore('chat.submit', { content: 'hello' }),
    ).rejects.toMatchObject({
      message: '还没有可用模型，请先配置模型。',
      code: 'model_configuration_required',
      action: 'open_model_settings',
    })
  })

  it('delegates onCoreEvent to the preload bridge', () => {
    const events: unknown[] = []
    const unsubscribe = () => {
      events.push('off')
    }
    g.window = {
      emperor: {
        onCoreEvent: (listener: (event: unknown) => void) => {
          listener({ event: 'ready' })
          return unsubscribe
        },
      },
    }

    expect(
      onCoreEvent((event) => {
        events.push(event)
      }),
    ).toBe(unsubscribe)
    expect(events).toEqual([{ event: 'ready' }])
  })

  it('delegates openPath to the preload bridge and reports failures', async () => {
    const calls: string[] = []
    g.window = {
      emperor: {
        openPath: async (target: string) => {
          calls.push(target)
          return { ok: true }
        },
      },
    }

    await expect(openPath('/tmp/emperor')).resolves.toBeUndefined()
    expect(calls).toEqual(['/tmp/emperor'])

    g.window = {
      emperor: { openPath: async () => ({ ok: false, error: 'not found' }) },
    }
    await expect(openPath('/missing')).rejects.toThrow('not found')
  })
})

function _assertRendererBridgeTypes(): void {
  void invokeCore('sessions.rename', 's1', { title: 'Typed' })

  // @ts-expect-error renderer operation keys are closed
  void invokeCore('missing.operation')

  // @ts-expect-error sessions.rename requires a patch
  void invokeCore('sessions.rename', 's1')

  // @ts-expect-error desktopPet.setEnabled requires a boolean
  void invokeCore('desktopPet.setEnabled', 'true')
}
