import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORE_EVENT_CHANNEL,
  PET_EVENT_CHANNEL,
  SESSION_EVENT_CHANNEL,
} from '../shared/ipc-contract'
import {
  CoreEventBridge,
  SESSION_EVENT_BATCH_MS,
  SessionEventBridge,
} from './event-bridge'

describe('CoreEventBridge (MIG-IPC-003)', () => {
  it('broadcasts core runtime events to attached renderer windows', () => {
    const bridge = new CoreEventBridge()
    const first = new FakeWebContents()
    const second = new FakeWebContents()

    bridge.attach(first)
    bridge.attach(second)
    bridge.emit({ event: 'message_delta', delta: 'hi' })

    expect(first.sent).toEqual([
      [CORE_EVENT_CHANNEL, { event: 'message_delta', delta: 'hi' }],
    ])
    expect(second.sent).toEqual([
      [CORE_EVENT_CHANNEL, { event: 'message_delta', delta: 'hi' }],
    ])
  })

  it('skips destroyed windows and supports detach', () => {
    const bridge = new CoreEventBridge()
    const live = new FakeWebContents()
    const destroyed = new FakeWebContents(true)
    bridge.attach(live)
    bridge.attach(destroyed)

    bridge.detach(live)
    bridge.emit({ event: 'ready' })

    expect(live.sent).toEqual([])
    expect(destroyed.sent).toEqual([])
    expect(bridge.size()).toBe(0)
  })

  it('sends pets only the redacted PetEvent channel', () => {
    const bridge = new CoreEventBridge()
    const main = new FakeWebContents()
    const pet = new FakeWebContents()
    bridge.attach(main)
    bridge.attachPet(pet)

    bridge.emit({
      event: 'tool_call',
      name: 'bash',
      arguments: { command: 'cat /Users/private/.env' },
      authorization: { fingerprint: 'secret-token' },
    })

    expect(main.sent[0]?.[0]).toBe(CORE_EVENT_CHANNEL)
    expect(pet.sent).toEqual([
      [
        PET_EVENT_CHANNEL,
        { type: 'activity', animation: 'building', label: 'running' },
      ],
    ])
    expect(JSON.stringify(pet.sent)).not.toContain('/Users/private')
    expect(JSON.stringify(pet.sent)).not.toContain('secret-token')
    expect(JSON.stringify(pet.sent)).not.toContain(CORE_EVENT_CHANNEL)
  })
})

describe('SessionEventBridge', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function event(seq: number, type = 'todo/write', data: unknown = {}) {
    return { type, seq, time: 0, data }
  }

  it('batches watched sessions per session every frame', () => {
    vi.useFakeTimers()
    const watched = new Set(['s1', 's2'])
    const bridge = new SessionEventBridge({
      isWatched: (id) => watched.has(id),
    })
    const main = new FakeWebContents()
    bridge.attach(main)
    const tap = bridge.tap()
    tap('s1', event(0))
    tap('s2', event(0))
    tap('s1', event(1))
    tap('other', event(0))
    expect(main.sent).toEqual([])
    vi.advanceTimersByTime(SESSION_EVENT_BATCH_MS)
    expect(main.sent).toEqual([
      [
        SESSION_EVENT_CHANNEL,
        { sessionId: 's1', events: [event(0), event(1)] },
      ],
      [SESSION_EVENT_CHANNEL, { sessionId: 's2', events: [event(0)] }],
    ])
    tap('s1', event(2))
    vi.advanceTimersByTime(SESSION_EVENT_BATCH_MS)
    expect(main.sent).toHaveLength(3)
    expect(main.sent[2]).toEqual([
      SESSION_EVENT_CHANNEL,
      { sessionId: 's1', events: [event(2)] },
    ])
  })

  it('follows the watch filter and drops events without a renderer', () => {
    vi.useFakeTimers()
    let watched = new Set<string>()
    const bridge = new SessionEventBridge()
    const main = new FakeWebContents()
    bridge.push('s1', event(0))
    bridge.attach(main)
    bridge.push('s1', event(1))
    bridge.setWatchFilter((id) => watched.has(id))
    bridge.push('s1', event(2))
    watched = new Set(['s1'])
    bridge.push('s1', event(3))
    bridge.flush()
    expect(main.sent).toEqual([
      [SESSION_EVENT_CHANNEL, { sessionId: 's1', events: [event(3)] }],
    ])
    bridge.detach(main)
    bridge.push('s1', event(4))
    vi.advanceTimersByTime(SESSION_EVENT_BATCH_MS)
    expect(main.sent).toHaveLength(1)
    expect(bridge.size()).toBe(0)
  })

  it('sanitizes large settled payloads but never chunks', () => {
    const bridge = new SessionEventBridge({ isWatched: () => true })
    const main = new FakeWebContents()
    bridge.attach(main)
    const args = 'x'.repeat(200_000)
    const chunk = event(1, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: args },
    })
    bridge.push(
      's1',
      event(0, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'write',
        arguments: args,
      }),
    )
    bridge.push('s1', chunk)
    bridge.flush()
    const batch = main.sent[0]?.[1] as {
      events: Array<{ data: { arguments?: string }; wire?: unknown }>
    }
    expect(batch.events[0]?.wire).toMatchObject({
      truncated: true,
      field: 'arguments',
      bytes: 200_000,
    })
    expect(batch.events[0]?.data.arguments?.length).toBeLessThan(args.length)
    expect(batch.events[1]).toBe(chunk)
  })

  it('skips destroyed windows and clears queued events on dispose', () => {
    vi.useFakeTimers()
    const bridge = new SessionEventBridge({ isWatched: () => true })
    const destroyed = new FakeWebContents(true)
    const live = new FakeWebContents()
    bridge.attach(destroyed)
    bridge.attach(live)
    bridge.push('s1', event(0))
    bridge.dispose()
    vi.advanceTimersByTime(SESSION_EVENT_BATCH_MS)
    expect(live.sent).toEqual([])
    bridge.push('s1', event(1))
    bridge.flush()
    expect(live.sent).toHaveLength(1)
    expect(destroyed.sent).toEqual([])
  })
})

class FakeWebContents {
  readonly sent: unknown[][] = []
  constructor(private readonly destroyed = false) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }
}
