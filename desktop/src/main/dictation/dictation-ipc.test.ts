import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  DICTATION_CANCEL_CHANNEL,
  DICTATION_EVENT_CHANNEL,
  DICTATION_START_CHANNEL,
  DICTATION_STATUS_CHANNEL,
  DICTATION_STOP_CHANNEL,
  type DictationEvent,
} from '../../shared/ipc-contract'
import type { DictationListener } from './dictation-service'
import { registerDictationIpc } from './dictation-ipc'

class FakeSender extends EventEmitter {
  destroyed = false
  readonly sent: Array<[string, unknown]> = []
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

function setup() {
  const handlers = new Map<
    string,
    (event: unknown, payload?: unknown) => unknown
  >()
  const listeners: DictationListener[] = []
  const service = {
    status: vi.fn(async () => ({ supported: true, available: true }) as never),
    start: vi.fn(async (_request: unknown, listener: DictationListener) => {
      listeners.push(listener)
      return { ok: true as const, session: 'session-0001' }
    }),
    stop: vi.fn(() => true),
    cancel: vi.fn(() => true),
  }
  const authorize = vi.fn()
  registerDictationIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
    },
    authorize,
    service,
  })
  const sender = new FakeSender()
  const call = async (channel: string, payload?: unknown) =>
    await handlers.get(channel)!({ sender }, payload)
  return { handlers, service, authorize, sender, call, listeners }
}

const started: DictationEvent = {
  type: 'started',
  session: 'session-0001',
  seq: 1,
  locale: 'zh-CN',
}

describe('dictation IPC', () => {
  it('registers the four channels and authorizes each before reading it', async () => {
    const { handlers, authorize, service, call } = setup()
    expect([...handlers.keys()].sort()).toEqual(
      [
        DICTATION_CANCEL_CHANNEL,
        DICTATION_START_CHANNEL,
        DICTATION_STATUS_CHANNEL,
        DICTATION_STOP_CHANNEL,
      ].sort(),
    )
    authorize.mockImplementation(() => {
      throw new Error('untrusted sender')
    })
    for (const channel of handlers.keys())
      await expect(call(channel, { session: 'session-0001' })).rejects.toThrow(
        'untrusted sender',
      )
    expect(service.status).not.toHaveBeenCalled()
    expect(service.start).not.toHaveBeenCalled()
    expect(service.stop).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
  })

  it('starts with a checked request and sends events only to that window', async () => {
    const { call, service, sender, listeners } = setup()
    expect(
      await call(DICTATION_START_CHANNEL, { locale: 'zh-CN', device: null }),
    ).toEqual({ ok: true, session: 'session-0001' })
    expect(service.start.mock.calls[0]![0]).toEqual({
      locale: 'zh-CN',
      device: null,
    })
    expect(listeners[0]!.deliver(started)).toBe(true)
    expect(sender.sent).toEqual([[DICTATION_EVENT_CHANNEL, started]])

    sender.destroyed = true
    expect(listeners[0]!.deliver(started)).toBe(false)
    expect(sender.sent).toHaveLength(1)
  })

  it('refuses malformed start requests', async () => {
    const { call, service } = setup()
    for (const payload of [
      null,
      'zh-CN',
      [],
      { locale: 7 },
      { device: {} },
      { locale: 'zh-CN', extra: true },
    ])
      expect(await call(DICTATION_START_CHANNEL, payload)).toMatchObject({
        ok: false,
        code: 'invalid_request',
      })
    expect(service.start).not.toHaveBeenCalled()
    expect(await call(DICTATION_START_CHANNEL)).toEqual({
      ok: true,
      session: 'session-0001',
    })
    expect(service.start.mock.calls[0]![0]).toEqual({})
  })

  it('cancels when the window goes away, and forgets the window afterwards', async () => {
    const { call, service, sender, listeners } = setup()
    await call(DICTATION_START_CHANNEL, {})
    expect(sender.listenerCount('destroyed')).toBe(1)
    sender.emit('destroyed')
    expect(service.cancel).toHaveBeenCalledWith('session-0001')

    await call(DICTATION_START_CHANNEL, {})
    listeners[1]!.closed?.()
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
  })

  it('stops and cancels by session id only', async () => {
    const { call, service } = setup()
    expect(
      await call(DICTATION_STOP_CHANNEL, { session: 'session-0001' }),
    ).toEqual({ ok: true })
    expect(service.stop).toHaveBeenCalledWith('session-0001')
    expect(
      await call(DICTATION_CANCEL_CHANNEL, { session: 'session-0001' }),
    ).toEqual({ ok: true })
    expect(service.cancel).toHaveBeenCalledWith('session-0001')
    for (const payload of [undefined, {}, { session: 'x' }, { session: 7 }]) {
      expect(await call(DICTATION_STOP_CHANNEL, payload)).toEqual({ ok: false })
      expect(await call(DICTATION_CANCEL_CHANNEL, payload)).toEqual({
        ok: false,
      })
    }
    expect(service.stop).toHaveBeenCalledTimes(1)
    expect(service.cancel).toHaveBeenCalledTimes(1)
  })

  it('answers the status as the service reports it', async () => {
    const { call } = setup()
    expect(await call(DICTATION_STATUS_CHANNEL)).toEqual({
      supported: true,
      available: true,
    })
  })
})
