import { describe, expect, it, vi } from 'vitest'
import { createRouteOwnerController, routeOwnerFromLineage } from './routeOwner'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('child navigation owner', () => {
  it('activates a native child owning root from persisted lineage and rejects malformed/foreign chains', () => {
    const known = (id: string) => id === 'root'
    expect(
      routeOwnerFromLineage(
        'sub-a',
        {
          chain: [
            { sessionId: 'root' },
            { sessionId: 'sub-parent' },
            { sessionId: 'sub-a' },
          ],
        },
        known,
      ),
    ).toBe('root')
    expect(
      routeOwnerFromLineage(
        'sub-a',
        { chain: [{ sessionId: 'foreign' }, { sessionId: 'sub-a' }] },
        known,
      ),
    ).toBeUndefined()
    expect(
      routeOwnerFromLineage(
        'sub-a',
        { chain: [{ sessionId: 'root' }, { sessionId: 'sub-other' }] },
        known,
      ),
    ).toBeUndefined()
    expect(
      routeOwnerFromLineage(
        'dlg-a',
        { chain: [{ sessionId: 'root' }, { sessionId: 'dlg-a' }] },
        known,
      ),
    ).toBeUndefined()
  })

  it('does not activate a previous native child owner after rapid navigation', async () => {
    const old = deferred<string | undefined>()
    const activate = vi.fn(async () => undefined)
    const controller = createRouteOwnerController({
      resolve: async (id) => (id === 'sub-old' ? old.promise : 'new-root'),
      activate,
      isActive: () => false,
    })
    const previous = controller.sync('sub-old')
    await controller.sync('sub-new')
    old.resolve('old-root')
    await previous
    expect(activate.mock.calls).toEqual([['new-root']])
  })

  it('serializes in-flight root activations so the latest navigation owns controls', async () => {
    const first = deferred<void>()
    const started = deferred<void>()
    const activated: string[] = []
    const controller = createRouteOwnerController({
      resolve: async (id) => id,
      activate: async (id) => {
        if (id === 'old-root') {
          started.resolve()
          await first.promise
        }
        activated.push(id)
      },
      isActive: () => false,
    })
    const previous = controller.sync('old-root')
    await started.promise
    const latest = controller.sync('new-root')
    first.resolve()
    await Promise.all([previous, latest])
    expect(activated).toEqual(['old-root', 'new-root'])
  })
})
