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

    await expect(invokeCore('bootstrap', { sessionId: 's1' })).resolves.toEqual({ ok: true })
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

    await expect(invokeCore('model.test')).rejects.toMatchObject({
      message: 'Internal error',
      errorId: 'ipc_abc123',
    })
  })

  it('delegates onCoreEvent to the preload bridge', () => {
    const events: unknown[] = []
    const unsubscribe = () => { events.push('off') }
    g.window = {
      emperor: {
        onCoreEvent: (listener: (event: unknown) => void) => {
          listener({ event: 'ready' })
          return unsubscribe
        },
      },
    }

    expect(onCoreEvent((event) => { events.push(event) })).toBe(unsubscribe)
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

    g.window = { emperor: { openPath: async () => ({ ok: false, error: 'not found' }) } }
    await expect(openPath('/missing')).rejects.toThrow('not found')
  })
})
