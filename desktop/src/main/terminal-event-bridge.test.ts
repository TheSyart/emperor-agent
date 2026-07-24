import { describe, expect, it } from 'vitest'
import { TERMINAL_EVENT_CHANNEL } from '../shared/ipc-contract'
import { TerminalEventBridge } from './terminal-event-bridge'

describe('TerminalEventBridge', () => {
  it('targets only the current main renderer and drops destroyed targets', () => {
    const bridge = new TerminalEventBridge()
    const first = new FakeWebContents()
    const second = new FakeWebContents()
    bridge.attach(first)
    bridge.attach(second)

    bridge.setSubscription(second, { sessionId: 's1', terminalId: 't1' })
    bridge.emit({
      type: 'output',
      sessionId: 's1',
      terminalId: 't1',
      seq: 1,
      data: 'hello',
    })

    expect(first.sent).toEqual([])
    bridge.emit({
      type: 'output',
      sessionId: 's1',
      terminalId: 't1',
      seq: 2,
      data: ' world',
    })
    bridge.flush()
    expect(second.sent).toEqual([
      [
        TERMINAL_EVENT_CHANNEL,
        [
          {
            type: 'output',
            sessionId: 's1',
            terminalId: 't1',
            seq: 1,
            data: 'hello',
          },
          {
            type: 'output',
            sessionId: 's1',
            terminalId: 't1',
            seq: 2,
            data: ' world',
          },
        ],
      ],
    ])
    second.destroyed = true
    bridge.emit({
      type: 'exit',
      sessionId: 's1',
      terminalId: 't1',
      seq: 3,
      exitCode: 0,
    })
    expect(second.sent).toHaveLength(1)
  })

  it('forwards only active terminal output while preserving session exit events', () => {
    const bridge = new TerminalEventBridge()
    const target = new FakeWebContents()
    bridge.attach(target)
    bridge.setSubscription(target, { sessionId: 's1', terminalId: 'active' })
    bridge.emit({
      type: 'output',
      sessionId: 's1',
      terminalId: 'inactive',
      seq: 1,
      data: 'hidden',
    })
    bridge.emit({
      type: 'exit',
      sessionId: 's1',
      terminalId: 'inactive',
      seq: 2,
      exitCode: 0,
    })
    bridge.emit({
      type: 'exit',
      sessionId: 's2',
      terminalId: 'other-session',
      seq: 3,
      exitCode: 0,
    })

    expect(target.sent).toEqual([
      [
        TERMINAL_EVENT_CHANNEL,
        {
          type: 'exit',
          sessionId: 's1',
          terminalId: 'inactive',
          seq: 2,
          exitCode: 0,
        },
      ],
    ])
  })
})

class FakeWebContents {
  readonly sent: unknown[][] = []
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }
}
