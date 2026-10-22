import { expect, it, vi } from 'vitest'
import { DelegationResources } from './resources'
it('shared writes block an external exclusive lease until all writers release', async () => {
  const r = new DelegationResources()
  const a = await r.acquire({ keys: ['ws'], mode: 'shared', owner: 'tool' })
  const b = await r.acquire({ keys: ['ws'], mode: 'shared', owner: 'job' })
  const got = vi.fn()
  const pending = r
    .acquire({ keys: ['ws'], mode: 'exclusive', owner: 'external' })
    .then((l) => {
      got()
      return l
    })
  await new Promise((resolve) => setImmediate(resolve))
  expect(got).not.toHaveBeenCalled()
  a.release()
  expect(r.hasActive('ws')).toBe(true)
  b.release()
  const c = await pending
  expect(got).toHaveBeenCalledOnce()
  c.release()
  expect(r.hasActive('ws')).toBe(false)
})
it('takes multiple keys atomically, independent workspaces continue, cancellation releases queue', async () => {
  const r = new DelegationResources()
  const a = await r.acquire({ keys: ['a'], mode: 'exclusive', owner: 'a' })
  const c = new AbortController()
  const p = r.acquire(
    { keys: ['b', 'a'], mode: 'exclusive', owner: 'waiter' },
    c.signal,
  )
  expect(r.hasActive('b')).toBe(false)
  const b = await r.acquire({
    keys: ['c'],
    mode: 'shared',
    owner: 'independent',
  })
  c.abort()
  await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  a.release()
  b.release()
})
it('does not starve an exclusive waiter with new shared writers', async () => {
  const r = new DelegationResources()
  const a = await r.acquire({ keys: ['a'], mode: 'shared', owner: 'first' })
  const order: string[] = []
  const x = r
    .acquire({ keys: ['a'], mode: 'exclusive', owner: 'x' })
    .then((l) => {
      order.push('x')
      return l
    })
  const y = r.acquire({ keys: ['a'], mode: 'shared', owner: 'y' }).then((l) => {
    order.push('y')
    return l
  })
  a.release()
  const xl = await x
  expect(order).toEqual(['x'])
  xl.release()
  ;(await y).release()
  expect(order).toEqual(['x', 'y'])
})
