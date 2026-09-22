import { describe, expect, it, vi } from 'vitest'
import { createSubagentCountStore } from './subagentCounts'

describe('subagent count store', () => {
  it('counts running children of running sessions and clears settled ones', async () => {
    const fetchChildren = vi.fn(async () => [
      {
        subagentId: 'a',
        description: '',
        mode: 'task',
        background: false,
        status: 'running',
      },
      {
        subagentId: 'b',
        description: '',
        mode: 'task',
        background: false,
        status: 'running',
      },
      {
        subagentId: 'c',
        description: '',
        mode: 'task',
        background: false,
        status: 'settled',
      },
    ])
    const store = createSubagentCountStore(fetchChildren as never, 0)
    store.sync(['s1'])
    await vi.waitFor(() => expect(store.counts.s1).toBe(2))
    store.sync([])
    expect(store.counts.s1).toBeUndefined()
  })

  it('debounces event-driven refreshes per session', async () => {
    vi.useFakeTimers()
    const fetchChildren = vi.fn(async () => [])
    const store = createSubagentCountStore(fetchChildren as never, 300)
    store.schedule('s1')
    store.schedule('s1')
    store.schedule('s1')
    await vi.advanceTimersByTimeAsync(310)
    expect(fetchChildren).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('ignores draft sessions', async () => {
    const fetchChildren = vi.fn(async () => [])
    const store = createSubagentCountStore(fetchChildren as never, 0)
    await store.refresh('draft:1')
    expect(fetchChildren).not.toHaveBeenCalled()
  })
})
