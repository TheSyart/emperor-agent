import { describe, expect, it } from 'vitest'
import { CORE_EVENT_CHANNEL, PET_EVENT_CHANNEL } from '../shared/ipc-contract'
import { CoreEventBridge } from './event-bridge'

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
      name: 'run_command',
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
