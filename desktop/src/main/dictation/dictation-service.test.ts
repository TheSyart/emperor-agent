import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationEvent } from '../../shared/ipc-contract'
import {
  DictationService,
  type DictationServiceOptions,
} from './dictation-service'
import type { DictationChild } from './helper-process'

type Request = Record<string, unknown>
type Script = (request: Request, helper: FakeHelper) => void

const statusEvent = {
  type: 'status',
  permissions: { microphone: 'granted', speech: 'granted' },
  devices: [
    { id: 'BuiltInMicrophoneDevice', name: '内建麦克风', default: true },
  ],
  locales: [
    { id: 'en-US', name: '英语（美国）' },
    { id: 'zh-CN', name: '中文（中国大陆）' },
  ],
  systemLocale: 'zh-Hans-CN',
  engine: 'sf-speech',
}

/** Answers like the real helper unless a test overrides a request type. */
const standard: Script = (request, helper) => {
  const session = request.session as string
  switch (request.type) {
    case 'hello':
      return helper.emit({ type: 'hello', protocol: 1, engine: 'sf-speech' })
    case 'status':
      return helper.emit(statusEvent)
    case 'start':
      return helper.emit({
        type: 'started',
        session,
        seq: 1,
        locale: (request.locale as string | null) ?? 'zh-CN',
      })
    case 'stop':
      helper.emit({
        type: 'final',
        session,
        seq: helper.next(),
        text: '你好。',
      })
      return helper.emit({
        type: 'ended',
        session,
        seq: helper.next(),
        reason: 'stopped',
      })
    case 'cancel':
      return helper.emit({
        type: 'ended',
        session,
        seq: helper.next(),
        reason: 'cancelled',
      })
  }
}

class FakeChild extends EventEmitter implements DictationChild {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly signals: string[] = []
  exited = false
  stdinEnded = false
  readonly stdin = {
    write: (chunk: string) => {
      queueMicrotask(() => this.helper.receive(chunk))
      return true
    },
    end: () => {
      this.stdinEnded = true
      // The real helper cancels whatever runs and exits on EOF.
      queueMicrotask(() => this.exit(0, null))
    },
    on: () => this.stdin,
  }

  constructor(private readonly helper: FakeHelper) {
    super()
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    queueMicrotask(() => this.exit(null, signal))
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, signal)
  }
}

class FakeHelper {
  readonly requests: Request[] = []
  readonly child = new FakeChild(this)
  seq = 1
  private buffer = ''

  constructor(private readonly script: Script) {}

  next(): number {
    this.seq += 1
    return this.seq
  }

  receive(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      const request = JSON.parse(line) as Request
      this.requests.push(request)
      this.script(request, this)
    }
  }

  emit(event: object): void {
    this.line(JSON.stringify(event))
  }

  line(text: string): void {
    if (!this.child.exited)
      this.child.stdout.emit('data', Buffer.from(`${text}\n`))
  }

  of(type: string): Request[] {
    return this.requests.filter((request) => request.type === type)
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++)
    await new Promise<void>((resolve) => setImmediate(resolve))
}

function setup(
  script: (standardScript: Script) => Script = (base) => base,
  options: Partial<DictationServiceOptions> = {},
) {
  const helpers: FakeHelper[] = []
  const service = new DictationService({
    platform: 'darwin',
    executable: () => '/Apps/Emperor Dictation Helper.app/Contents/MacOS/x',
    spawn: () => {
      const helper = new FakeHelper(script(standard))
      helpers.push(helper)
      return helper.child
    },
    randomId: (() => {
      let count = 0
      return () => `session-${String(++count).padStart(4, '0')}`
    })(),
    log: () => undefined,
    ...options,
  })
  const events: DictationEvent[] = []
  const listener = {
    deliver: vi.fn((event: DictationEvent) => {
      events.push(event)
      return true
    }),
    closed: vi.fn(),
  }
  return {
    service,
    events,
    listener,
    helper: () => helpers.at(-1)!,
    helpers,
  }
}

function summary(events: DictationEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case 'started':
        return `${event.seq} started ${event.locale}`
      case 'partial':
      case 'final':
        return `${event.seq} ${event.type} ${event.text}`
      case 'level':
        return `${event.seq} level ${event.value}`
      case 'error':
        return `${event.seq} error ${event.code}`
      case 'ended':
        return `${event.seq} ended ${event.reason}`
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dictation service', () => {
  it('reports the helper status, and why when there is none', async () => {
    const { service, helper } = setup()
    expect(await service.status()).toEqual({
      supported: true,
      available: true,
      engine: 'sf-speech',
      permissions: { microphone: 'granted', speech: 'granted' },
      devices: statusEvent.devices,
      locales: statusEvent.locales,
      systemLocale: 'zh-Hans-CN',
      active: false,
    })
    expect(helper().requests.map((request) => request.type)).toEqual([
      'hello',
      'status',
    ])

    const windows = await new DictationService({
      platform: 'win32',
      executable: () => null,
    }).status()
    expect(windows).toMatchObject({
      supported: false,
      available: false,
      permissions: { microphone: 'unknown', speech: 'unknown' },
      devices: [],
      locales: [],
    })
    expect(windows.reason).toMatch(/macOS/)

    const missing = await new DictationService({
      platform: 'darwin',
      executable: () => null,
    }).status()
    expect(missing).toMatchObject({ supported: true, available: false })
    expect(missing.reason).toMatch(/Emperor Dictation Helper/)
  })

  it('starts, streams partial results, and stops with one final', async () => {
    const { service, helper, listener, events } = setup()
    const result = await service.start({ locale: 'zh-CN' }, listener)
    expect(result).toEqual({ ok: true, session: 'session-0001' })
    await flush()
    expect(helper().of('start')).toEqual([
      {
        type: 'start',
        session: 'session-0001',
        locale: 'zh-CN',
        device: null,
        maxSeconds: 300,
      },
    ])
    helper().emit({
      type: 'partial',
      session: 'session-0001',
      seq: helper().next(),
      text: '你',
    })
    helper().emit({
      type: 'partial',
      session: 'session-0001',
      seq: helper().next(),
      text: '你好',
    })
    await flush()
    expect((await service.status()).active).toBe(true)
    expect(service.stop('session-0001')).toBe(true)
    await flush()
    expect(summary(events)).toEqual([
      '1 started zh-CN',
      '2 partial 你',
      '3 partial 你好',
      '4 final 你好。',
      '5 ended stopped',
    ])
    expect(events.every((event) => event.session === 'session-0001')).toBe(true)
    expect(listener.closed).toHaveBeenCalledTimes(1)
    expect((await service.status()).active).toBe(false)
  })

  it('follows the system language and default microphone unless told otherwise', async () => {
    const { service, helper, listener } = setup()
    await service.start({}, listener)
    await flush()
    expect(helper().of('start')[0]).toMatchObject({
      locale: null,
      device: null,
    })
    service.stop('session-0001')
    await flush()
    await service.start({ locale: 'en-US', device: 'USBMic-1' }, listener)
    await flush()
    expect(helper().of('start')[1]).toMatchObject({
      locale: 'en-US',
      device: 'USBMic-1',
    })
  })

  it('refuses malformed languages and devices before the helper hears of them', async () => {
    const { service, helper, listener } = setup()
    for (const request of [
      { locale: '../etc' },
      { locale: 7 },
      { device: '' },
      { device: 'x'.repeat(257) },
    ]) {
      const result = await service.start(request as never, listener)
      expect(result).toMatchObject({ ok: false, code: 'invalid_request' })
    }
    await flush()
    expect(helper()?.of('start') ?? []).toEqual([])
  })

  it('passes on an unsupported language, denied permission and a missing microphone', async () => {
    for (const [code, message] of [
      ['unsupported_locale', '这台 Mac 不能在本机识别 fr-FR'],
      ['permission_denied', '没有麦克风权限'],
      ['no_device', '没有可用的麦克风'],
    ] as const) {
      const { service, listener, events, helper } = setup(
        (base) => (request, fake) => {
          if (request.type !== 'start') return base(request, fake)
          const session = request.session as string
          fake.emit({ type: 'error', session, seq: 1, code, message })
          fake.emit({ type: 'ended', session, seq: 2, reason: 'error' })
        },
      )
      expect((await service.start({ locale: 'fr-FR' }, listener)).ok).toBe(true)
      await flush()
      expect(summary(events)).toEqual([`1 error ${code}`, '2 ended error'])
      expect(events[0]).toMatchObject({ message })
      expect(listener.closed).toHaveBeenCalledTimes(1)
      // Nothing is retried another way (no second start, no other engine).
      expect(helper().of('start')).toHaveLength(1)
      expect((await service.status()).active).toBe(false)
    }
  })

  it('stays on device: a missing on-device model fails instead of retrying', async () => {
    const { service, listener, events, helper } = setup(
      (base) => (request, fake) => {
        if (request.type !== 'start') return base(request, fake)
        const session = request.session as string
        fake.emit({
          type: 'error',
          session,
          seq: 1,
          code: 'recognizer_unavailable',
          message: '本机识别模型不可用',
        })
        fake.emit({ type: 'ended', session, seq: 2, reason: 'error' })
      },
    )
    await service.start({ locale: 'zh-CN' }, listener)
    await flush()
    expect(summary(events)).toEqual([
      '1 error recognizer_unavailable',
      '2 ended error',
    ])
    expect(helper().of('start')).toHaveLength(1)
    expect(Object.keys(helper().of('start')[0]!).sort()).toEqual([
      'device',
      'locale',
      'maxSeconds',
      'session',
      'type',
    ])
  })

  it('delivers one final, and drops repeated, late and out-of-order events', async () => {
    const { service, listener, events, helper } = setup()
    await service.start({}, listener)
    await flush()
    const session = 'session-0001'
    helper().emit({ type: 'partial', session, seq: 3, text: '三' })
    helper().emit({ type: 'partial', session, seq: 2, text: '二' })
    helper().emit({ type: 'partial', session, seq: 3, text: '三' })
    helper().emit({
      type: 'partial',
      session: 'session-9999',
      seq: 4,
      text: '别处',
    })
    helper().emit({ type: 'final', session, seq: 4, text: '终' })
    helper().emit({ type: 'final', session, seq: 5, text: '终' })
    helper().emit({ type: 'partial', session, seq: 6, text: '迟到' })
    helper().emit({ type: 'ended', session, seq: 7, reason: 'stopped' })
    helper().emit({ type: 'final', session, seq: 8, text: '结束之后' })
    await flush()
    expect(summary(events)).toEqual([
      '1 started zh-CN',
      '3 partial 三',
      '4 final 终',
      '7 ended stopped',
    ])
  })

  it('passes on the loudness in order, until the final (RV-06)', async () => {
    const { service, listener, events, helper } = setup()
    await service.start({}, listener)
    await flush()
    const session = 'session-0001'
    helper().emit({ type: 'level', session, seq: 2, value: 0.1 })
    helper().emit({ type: 'level', session, seq: 4, value: 0.6 })
    helper().emit({ type: 'level', session, seq: 3, value: 0.3 })
    helper().emit({ type: 'partial', session, seq: 5, text: '你' })
    helper().emit({ type: 'final', session, seq: 6, text: '你。' })
    helper().emit({ type: 'level', session, seq: 7, value: 0.9 })
    helper().emit({ type: 'ended', session, seq: 8, reason: 'stopped' })
    await flush()
    expect(summary(events)).toEqual([
      '1 started zh-CN',
      '2 level 0.1',
      '4 level 0.6',
      '5 partial 你',
      '6 final 你。',
      '8 ended stopped',
    ])
  })

  it('cancels without a final', async () => {
    const { service, listener, events, helper } = setup()
    await service.start({}, listener)
    await flush()
    helper().emit({
      type: 'partial',
      session: 'session-0001',
      seq: helper().next(),
      text: '不要了',
    })
    expect(service.cancel('session-0001')).toBe(true)
    await flush()
    expect(summary(events)).toEqual([
      '1 started zh-CN',
      '2 partial 不要了',
      '3 ended cancelled',
    ])
    expect(helper().of('cancel')).toEqual([
      { type: 'cancel', session: 'session-0001' },
    ])
    expect(service.stop('session-0001')).toBe(false)
    expect(service.cancel('nope-nope-nope')).toBe(false)
  })

  it('allows one dictation at a time', async () => {
    const { service, listener, helper } = setup()
    expect((await service.start({}, listener)).ok).toBe(true)
    expect(await service.start({}, listener)).toMatchObject({
      ok: false,
      code: 'busy',
    })
    await flush()
    expect(helper().of('start')).toHaveLength(1)
  })

  it('ends the dictation when the helper crashes, and starts a new helper next time', async () => {
    const { service, listener, events, helpers } = setup()
    await service.start({}, listener)
    await flush()
    helpers[0]!.child.stderr.emit('data', Buffer.from('fatal: boom\n'))
    helpers[0]!.child.exit(null, 'SIGSEGV')
    await flush()
    expect(summary(events)).toEqual([
      '1 started zh-CN',
      '2 error helper_exited',
      '3 ended error',
    ])
    expect(listener.closed).toHaveBeenCalledTimes(1)
    expect((await service.start({}, listener)).ok).toBe(true)
    await flush()
    expect(helpers).toHaveLength(2)
    expect(helpers[1]!.of('start')).toHaveLength(1)
  })

  it('treats unreadable helper output as a broken helper', async () => {
    const { service, listener, events, helpers } = setup()
    await service.start({}, listener)
    await flush()
    helpers[0]!.line('{"type":"partial","session":"session-0001","seq":"2"}')
    await flush()
    expect(summary(events)).toEqual([
      '1 started zh-CN',
      '2 error helper_exited',
      '3 ended error',
    ])
    expect(helpers[0]!.child.signals).toContain('SIGKILL')
  })

  it('gives up on a stop that never ends, and replaces the helper', async () => {
    const { service, listener, events, helpers } = setup(
      (base) => (request, fake) => {
        if (request.type === 'stop') return
        base(request, fake)
      },
    )
    await service.start({}, listener)
    await flush()
    service.stop('session-0001')
    await vi.advanceTimersByTimeAsync(14_999)
    expect(summary(events)).toEqual(['1 started zh-CN'])
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(summary(events)).toEqual([
      '1 started zh-CN',
      '2 error timeout',
      '3 ended error',
    ])
    expect(helpers[0]!.child.signals).toContain('SIGKILL')
    expect((await service.start({}, listener)).ok).toBe(true)
    await flush()
    expect(helpers).toHaveLength(2)
  })

  it('gives up when a start is never answered (a permission prompt left open)', async () => {
    const { service, listener, events, helper } = setup(
      (base) => (request, fake) => {
        if (request.type === 'start') return
        base(request, fake)
      },
    )
    await service.start({}, listener)
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)
    await flush()
    expect(summary(events)).toEqual(['1 error timeout', '2 ended error'])
    expect(helper().of('cancel')).toEqual([
      { type: 'cancel', session: 'session-0001' },
    ])
  })

  it('stops a dictation the helper lets run past its maximum', async () => {
    const { service, listener, events, helper } = setup(
      (base) => (request, fake) => {
        if (request.type === 'start') {
          fake.emit({
            type: 'started',
            session: request.session,
            seq: 1,
            locale: 'zh-CN',
          })
          return
        }
        base(request, fake)
      },
      { maxSeconds: 60 },
    )
    await service.start({}, listener)
    await flush()
    expect(helper().of('start')[0]).toMatchObject({ maxSeconds: 60 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(helper().of('stop')).toEqual([])
    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(helper().of('stop')).toEqual([
      { type: 'stop', session: 'session-0001' },
    ])
    expect(summary(events).at(-1)).toBe('3 ended stopped')
  })

  it('passes on the helper ending a dictation at its maximum', async () => {
    const { service, listener, events, helper } = setup()
    await service.start({}, listener)
    await flush()
    helper().emit({
      type: 'final',
      session: 'session-0001',
      seq: 2,
      text: '很长',
    })
    helper().emit({
      type: 'ended',
      session: 'session-0001',
      seq: 3,
      reason: 'max_duration',
    })
    await flush()
    expect(summary(events).slice(-2)).toEqual([
      '2 final 很长',
      '3 ended max_duration',
    ])
    expect((await service.status()).active).toBe(false)
  })

  it('cancels a dictation whose window is gone', async () => {
    const { service, helper } = setup()
    const listener = { deliver: vi.fn(() => true), closed: vi.fn() }
    await service.start({}, listener)
    await flush()
    listener.deliver.mockReturnValue(false)
    helper().emit({
      type: 'partial',
      session: 'session-0001',
      seq: 2,
      text: '没人听',
    })
    await flush()
    expect(helper().of('cancel')).toEqual([
      { type: 'cancel', session: 'session-0001' },
    ])
    expect(listener.closed).toHaveBeenCalledTimes(1)
    expect((await service.status()).active).toBe(false)
  })

  it('stops launching a helper that keeps crashing, for a minute', async () => {
    const { service, listener, helpers } = setup((base) => (request, fake) => {
      if (request.type === 'hello') {
        queueMicrotask(() => fake.child.exit(1, null))
        return
      }
      base(request, fake)
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await service.start({}, listener)).toMatchObject({
        ok: false,
        code: 'unavailable',
      })
    }
    expect(helpers).toHaveLength(3)
    const status = await service.status()
    expect(status.available).toBe(false)
    expect(status.reason).toMatch(/稍后/)
    expect(helpers).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(60_000)
    await service.status()
    expect(helpers).toHaveLength(4)
  })

  it('checks the packaged helper signature once, and refuses a bad one', async () => {
    const verify = vi.fn(async () => undefined)
    const { service } = setup(undefined, { verify })
    await service.status()
    await service.status()
    expect(verify).toHaveBeenCalledTimes(1)

    const bad = setup(undefined, {
      verify: async () => {
        throw new Error('signature changed')
      },
    })
    const status = await bad.service.status()
    expect(status.available).toBe(false)
    expect(bad.helpers).toHaveLength(0)
  })

  it('lets an idle helper go, and closes everything on dispose', async () => {
    const { service, listener, events, helpers } = setup(undefined, {
      idleExitMs: 1000,
    })
    await service.status()
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(helpers[0]!.child.stdinEnded).toBe(true)

    await service.start({}, listener)
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(helpers[1]!.child.stdinEnded).toBe(false)
    service.dispose()
    await flush()
    expect(helpers[1]!.of('cancel')).toEqual([
      { type: 'cancel', session: 'session-0001' },
    ])
    expect(helpers[1]!.child.stdinEnded).toBe(true)
    expect(summary(events).at(-1)).toBe('2 ended cancelled')
  })
})
