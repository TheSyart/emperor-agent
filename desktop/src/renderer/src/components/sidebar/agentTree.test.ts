import { describe, expect, it, vi } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import {
  agentLocation,
  buildAgentTree,
  createAgentTreeStore,
  visibleAgentChildren,
} from './agentTree'

function agent(
  id: string,
  parentAgentId = 'root',
  extra: Partial<AgentView> = {},
): AgentView {
  return {
    id,
    parentAgentId,
    rootSessionId: 'root',
    kind: 'external',
    backend: 'codex',
    title: id,
    phase: 'completed',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('unified sidebar agent tree', () => {
  it('loads durable running counts for idle roots, deduplicates stable identities across runs', async () => {
    const fetch = vi.fn(async () => ({
      agents: [
        agent('dlg-a', 'root', { phase: 'running', currentRunId: 'dgr-2' }),
        agent('dlg-a', 'root', {
          phase: 'completed',
          currentRunId: 'dgr-1',
          updatedAt: 0,
        }),
        agent('dlg-wait', 'root', { phase: 'waiting' }),
        agent('dlg-fail', 'root', { phase: 'failed' }),
        agent('dlg-unknown', 'root', { phase: 'unknown' }),
      ],
    }))
    const store = createAgentTreeStore(fetch)
    store.sync(['root'])
    await vi.waitFor(() => expect(store.counts.root).toBe(1))
    expect(store.trees.root.agents).toHaveLength(4)
    expect(store.expanded.root).not.toBe(true)
    store.sync(['root'])
    expect(fetch).toHaveBeenCalledTimes(1)
    store.sync([]) // archiving a root hides and invalidates its entire tree
    expect(store.trees.root).toBeUndefined()
    expect(store.counts.root).toBeUndefined()
  })

  it('nests beneath actual parents, exposes missing/cyclic parents without fabricating a root edge', () => {
    const tree = buildAgentTree('root', [
      agent('sub-a', 'root', { kind: 'internal', backend: 'internal' }),
      agent('dlg-b', 'sub-a'),
      agent('dlg-c', 'dlg-b'),
      agent('dlg-lost', 'missing'),
      agent('dlg-lost-child', 'dlg-lost'),
      agent('dlg-x', 'dlg-y'),
      agent('dlg-y', 'dlg-x'),
    ])
    expect(tree.children.root.map((a) => a.id)).toEqual(['sub-a'])
    expect(tree.children['sub-a'].map((a) => a.id)).toEqual(['dlg-b'])
    expect(tree.children['dlg-b'].map((a) => a.id)).toEqual(['dlg-c'])
    expect(tree.children['dlg-lost'].map((a) => a.id)).toEqual([
      'dlg-lost-child',
    ])
    expect(tree.unavailable.map((a) => a.id).sort()).toEqual([
      'dlg-lost',
      'dlg-x',
      'dlg-y',
    ])
  })

  it('limits the collapsed information list to five even when more children are active', () => {
    const agents = Array.from({ length: 7 }, (_, i) =>
      agent(`dlg-${i}`, 'root', { phase: 'running', updatedAt: i }),
    )
    expect(visibleAgentChildren(agents, false).map((a) => a.id)).toEqual([
      'dlg-6',
      'dlg-5',
      'dlg-4',
      'dlg-3',
      'dlg-2',
    ])
    expect(visibleAgentChildren(agents, true)).toHaveLength(7)
  })

  it('keeps active plus recent siblings, offers all, and reveals every ancestor for selection', async () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      agent(`dlg-${i}`, 'root', {
        updatedAt: i,
        phase: i === 0 ? 'running' : 'completed',
      }),
    )
    agents.push(agent('dlg-deep', 'dlg-1'))
    const store = createAgentTreeStore(async () => ({ agents }))
    store.sync(['root'])
    await vi.waitFor(() => expect(store.trees.root).toBeDefined())
    const children = store.trees.root.children.root
    expect(visibleAgentChildren(children, false).map((a) => a.id)).toEqual([
      'dlg-0',
      'dlg-7',
      'dlg-6',
      'dlg-5',
      'dlg-4',
    ])
    expect(visibleAgentChildren(children, true)).toHaveLength(8)
    store.reveal('root', 'dlg-deep')
    expect(store.expanded.root).toBe(true)
    expect(store.expanded['dlg-1']).toBe(true)
    expect(store.showAll.root).toBe(true)
    store.toggle('dlg-1')
    expect(store.expanded['dlg-1']).toBe(false)
    expect(store.trees.root.agents).toHaveLength(9)
  })

  it('auto-expands first live children once, honors explicit collapse and restores it after restart', async () => {
    let agents: AgentView[] = []
    let saved = ''
    const storage = {
      getItem: () => saved || null,
      setItem: (_: string, value: string) => {
        saved = value
      },
    }
    const store = createAgentTreeStore(async () => ({ agents }), { storage })
    store.sync(['root'])
    await vi.waitFor(() => expect(store.trees.root).toBeDefined())
    agents = [agent('sub-a')]
    await store.refresh('root')
    expect(store.expanded.root).toBe(true)
    store.toggle('root')
    agents = [...agents, agent('dlg-b')]
    await store.refresh('root')
    expect(store.expanded.root).toBe(false)
    const restarted = createAgentTreeStore(async () => ({ agents }), {
      storage,
    })
    restarted.sync(['root'])
    await vi.waitFor(() => expect(restarted.trees.root).toBeDefined())
    expect(restarted.expanded.root).toBe(false)
  })

  it.each([false, true])(
    'retains live expansion through deferred initial hydration (saved collapse: %s)',
    async (collapsed) => {
      vi.useFakeTimers()
      try {
        const initial = deferred<{ agents: AgentView[] }>()
        const replacement = deferred<{ agents: AgentView[] }>()
        const fetch = vi
          .fn()
          .mockReturnValueOnce(initial.promise)
          .mockReturnValueOnce(replacement.promise)
        const store = createAgentTreeStore(fetch, {
          debounceMs: 10,
          storage: {
            getItem: () =>
              collapsed
                ? JSON.stringify({
                    expanded: { root: false, 'sub-parent': false },
                  })
                : null,
            setItem: () => undefined,
          },
        })
        store.sync(['root'])
        store.handleEvent({
          event: 'agent_tree_changed',
          rootSessionId: 'root',
          revision: 1,
        })
        await vi.advanceTimersByTimeAsync(10)
        expect(fetch).toHaveBeenCalledTimes(2)
        replacement.resolve({
          agents: [
            agent('sub-parent'),
            agent('dlg-first', 'sub-parent', { phase: 'running' }),
          ],
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(store.counts.root).toBe(1)
        expect(store.expanded.root).toBe(!collapsed)
        expect(store.expanded['sub-parent']).toBe(!collapsed)
        // The superseded initial response must neither publish stale rows nor erase the live expansion.
        initial.resolve({ agents: [agent('stale-history')] })
        await vi.advanceTimersByTimeAsync(0)
        expect(store.trees.root.agents.map((child) => child.id).sort()).toEqual(
          ['dlg-first', 'sub-parent'],
        )
        expect(store.expanded.root).toBe(!collapsed)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('keeps a deferred initial historical snapshot collapsed when no live event arrives', async () => {
    const initial = deferred<{ agents: AgentView[] }>()
    const store = createAgentTreeStore(() => initial.promise)
    store.sync(['root'])
    initial.resolve({
      agents: [agent('sub-parent'), agent('dlg-history', 'sub-parent')],
    })
    await vi.waitFor(() => expect(store.trees.root).toBeDefined())
    expect(store.expanded.root).not.toBe(true)
    expect(store.expanded['sub-parent']).not.toBe(true)
  })

  it('ignores old, archived and rapid-navigation fetches; refreshes only the event root and never text', async () => {
    const first = deferred<{ agents: AgentView[] }>()
    const second = deferred<{ agents: AgentView[] }>()
    const fetch = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue({ agents: [] })
    const store = createAgentTreeStore(fetch, { debounceMs: 0 })
    store.sync(['root', 'other'])
    store.sync(['root'])
    const latest = store.refresh('root')
    await latest
    first.resolve({ agents: [agent('old')] })
    second.resolve({
      agents: [agent('foreign', 'other', { rootSessionId: 'other' })],
    })
    await Promise.resolve()
    expect(store.trees.root.agents).toHaveLength(0)
    expect(store.trees.other).toBeUndefined()
    store.handleEvent({
      event: 'subagent_delta',
      session_id: 'root',
      text: 'text',
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    store.handleEvent({
      event: 'agent_tree_changed',
      rootSessionId: 'root',
      revision: 2,
    })
    store.handleEvent({
      event: 'agent_tree_changed',
      rootSessionId: 'root',
      revision: 2,
    })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    expect(fetch.mock.calls[3]).toEqual([{ rootSessionIds: ['root'] }])
  })

  it('uses stable external delegation routes and native readonly session routes', () => {
    expect(
      agentLocation(agent('dlg-a', 'sub-a', { currentRunId: 'dgr-2' })),
    ).toEqual({
      name: 'external-agent',
      params: { sessionId: 'root', delegationId: 'dlg-a' },
    })
    expect(
      agentLocation(
        agent('sub-a', 'root', { kind: 'internal', backend: 'internal' }),
      ),
    ).toEqual({ name: 'chat', params: { sessionId: 'sub-a' } })
  })
})

describe('agent tree storage (SUB-34, AGT-10 test 11)', () => {
  function memory(initial: Record<string, unknown>) {
    let saved = JSON.stringify(initial)
    return {
      storage: {
        getItem: () => saved,
        setItem: (_: string, value: string) => {
          saved = value
        },
      },
      read: () =>
        JSON.parse(saved) as {
          expanded: Record<string, boolean>
          showAll: Record<string, boolean>
        },
    }
  }

  it('11 · keeps entries only for sessions and agents that still exist, once every tree loaded', async () => {
    const stale: Record<string, boolean> = {}
    for (let i = 0; i < 40; i += 1) stale[`gone-${i}`] = true
    const saved = memory({
      expanded: { ...stale, root: false, 'sub-a': true, other: true },
      showAll: { 'gone-1': true, 'sub-a': true },
    })
    const trees: Record<string, AgentView[]> = {
      root: [agent('sub-a')],
      other: [agent('dlg-b', 'other', { rootSessionId: 'other' })],
    }
    const store = createAgentTreeStore(
      async ({ rootSessionIds }) => ({ agents: trees[rootSessionIds[0]!]! }),
      { storage: saved.storage },
    )
    store.sync(['root', 'other'])
    await vi.waitFor(() =>
      expect(store.trees.root && store.trees.other).toBeDefined(),
    )
    store.toggle('dlg-b')
    const { expanded, showAll } = saved.read()
    const existing = ['root', 'other', 'sub-a', 'dlg-b']
    expect(Object.keys(expanded).every((id) => existing.includes(id))).toBe(
      true,
    )
    expect(Object.keys(expanded).length).toBeLessThanOrEqual(existing.length)
    expect(Object.keys(showAll)).toEqual(['sub-a'])
    // What the user chose for the remaining ones is kept.
    expect(expanded.root).toBe(false)
    expect(expanded['sub-a']).toBe(true)
  })

  it('does not drop a tree’s entries before that tree has loaded', async () => {
    const saved = memory({ expanded: { 'sub-late': true }, showAll: {} })
    let release!: (value: { agents: AgentView[] }) => void
    const store = createAgentTreeStore(
      ({ rootSessionIds }) =>
        rootSessionIds[0] === 'late'
          ? new Promise((resolve) => {
              release = resolve
            })
          : Promise.resolve({ agents: [] }),
      { storage: saved.storage },
    )
    store.sync(['root', 'late'])
    await vi.waitFor(() => expect(store.trees.root).toBeDefined())
    store.toggle('root')
    expect(saved.read().expanded['sub-late']).toBe(true)
    release({ agents: [agent('sub-late', 'late', { rootSessionId: 'late' })] })
    await vi.waitFor(() => expect(store.trees.late).toBeDefined())
    expect(saved.read().expanded['sub-late']).toBe(true)
  })
})
