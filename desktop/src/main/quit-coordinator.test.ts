import { describe, expect, it } from 'vitest'
import { createQuitCoordinator } from './quit-coordinator'

describe('graceful App quit', () => {
  it('holds quitting until the writer flushes and joins repeated requests', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const events: string[] = []
    let finished!: () => void
    const done = new Promise<void>((resolve) => {
      finished = resolve
    })
    const handler = createQuitCoordinator({
      close: async () => {
        events.push('closing')
        await gate
        events.push('flushed')
      },
      quit: () => {
        events.push('quit')
        finished()
      },
      onError: () => {
        events.push('error')
      },
    })
    const preventDefault = () => {
      events.push('prevented')
    }
    handler({ preventDefault })
    handler({ preventDefault })
    await Promise.resolve()
    expect(events).toEqual(['prevented', 'prevented', 'closing'])
    release()
    await done
    expect(events).toEqual([
      'prevented',
      'prevented',
      'closing',
      'flushed',
      'quit',
    ])
    handler({ preventDefault })
    expect(events.at(-1)).toBe('quit')
    expect(events.filter((e) => e === 'closing')).toHaveLength(1)
  })
  it('reports close failure before terminating; never leaves a second close running', async () => {
    const events: string[] = []
    let finished!: () => void
    const done = new Promise<void>((resolve) => {
      finished = resolve
    })
    const handler = createQuitCoordinator({
      close: async () => {
        throw new Error('flush failed')
      },
      onError: () => {
        events.push('reported')
      },
      quit: () => {
        events.push('quit')
        finished()
      },
    })
    handler({ preventDefault() {} })
    await done
    expect(events).toEqual(['reported', 'quit'])
  })
})
