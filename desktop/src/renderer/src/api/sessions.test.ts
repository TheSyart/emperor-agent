import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchSessionChildren,
  fetchSessionEvent,
  fetchSessionHistory,
  fetchSessionLineage,
  onSessionEvents,
  watchSessions,
  type SessionEventBatch,
} from './sessions'

const g = globalThis as unknown as { window?: any }

afterEach(() => {
  delete g.window
})

describe('raw session-log API', () => {
  it('maps history, lineage, children, and watch onto Core operations', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          switch (args[0]) {
            case 'sessions.history':
              return {
                header: { version: 0, id: 's1', createdAt: 0 },
                events: [],
                hasMore: false,
                lastSeq: -1,
              }
            case 'sessions.lineage':
              return { chain: [{ sessionId: 's1' }] }
            case 'sessions.children':
              return []
            case 'sessions.watch':
              return { watching: ['s1'] }
            case 'sessions.event':
              return { seq: 4, type: 'tool/result', time: 0, data: {} }
          }
          throw new Error('unexpected')
        },
      },
    }

    await expect(
      fetchSessionHistory({ sessionId: 's1', beforeSeq: 9 }),
    ).resolves.toMatchObject({ hasMore: false, lastSeq: -1 })
    await expect(fetchSessionLineage('s1')).resolves.toEqual({
      chain: [{ sessionId: 's1' }],
    })
    await expect(fetchSessionChildren('s1')).resolves.toEqual([])
    await expect(watchSessions(['s1'])).resolves.toEqual(['s1'])
    await expect(fetchSessionEvent('s1', 4)).resolves.toMatchObject({
      seq: 4,
      type: 'tool/result',
    })
    expect(calls).toEqual([
      ['sessions.history', { sessionId: 's1', beforeSeq: 9 }],
      ['sessions.lineage', { sessionId: 's1' }],
      ['sessions.children', { sessionId: 's1' }],
      ['sessions.watch', { sessionIds: ['s1'] }],
      ['sessions.event', { sessionId: 's1', seq: 4 }],
    ])
  })

  it('delegates onSessionEvents to the preload bridge, or no-ops without it', () => {
    const seen: SessionEventBatch[] = []
    const off = () => {}
    g.window = {
      emperor: {
        onSessionEvents: (listener: (batch: SessionEventBatch) => void) => {
          listener({ sessionId: 's1', events: [] })
          return off
        },
      },
    }
    expect(onSessionEvents((batch) => seen.push(batch))).toBe(off)
    expect(seen).toEqual([{ sessionId: 's1', events: [] }])

    g.window = {}
    expect(typeof onSessionEvents(() => {})).toBe('function')
  })
})
