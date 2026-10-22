import { it, expect, vi } from 'vitest'
import {
  createExternalHistoryFeed,
  type ExternalHistoryPage,
} from './externalHistoryFeed'
const entry = (id: string) => ({
  id,
  runId: 'dgr-one',
  type: 'text' as const,
  text: id,
})
it('subscribes before initial read, serializes output during load, deduplicates and drops disposed reads', async () => {
  let listener = () => {}
  let resolve!: (value: ExternalHistoryPage) => void
  const order: string[] = [],
    pages: ExternalHistoryPage[] = []
  const read = vi
    .fn()
    .mockImplementationOnce(() => {
      order.push('read')
      return new Promise((r) => {
        resolve = r
      })
    })
    .mockResolvedValueOnce({
      entries: [entry('a'), entry('b')],
      before: 'a',
      after: 'b',
      hasBefore: true,
      hasAfter: false,
    })
    .mockResolvedValue({
      entries: [],
      before: 'b',
      after: 'b',
      hasBefore: true,
      hasAfter: false,
    })
  const off = vi.fn()
  const feed = createExternalHistoryFeed({
    read,
    subscribe: (cb) => {
      order.push('subscribe')
      listener = cb
      return off
    },
    update: (page) => pages.push(page),
    error: (e) => {
      throw e
    },
  })
  const started = feed.start()
  await Promise.resolve()
  listener()
  listener()
  expect(read).toHaveBeenCalledTimes(1)
  resolve({
    entries: [entry('a')],
    before: 'a',
    after: 'a',
    hasBefore: false,
    hasAfter: false,
  })
  await started
  expect(order).toEqual(['subscribe', 'read'])
  expect(pages.at(-1)!.entries.map((e) => e.id)).toEqual(['a', 'b'])
  expect(read.mock.calls[1]?.[0]).toEqual({ after: 'a' })
  feed.dispose()
  expect(off).toHaveBeenCalledOnce()
  const count = pages.length
  listener()
  await Promise.resolve()
  expect(pages).toHaveLength(count)
})
it('does not apply a switched-out initial request', async () => {
  let resolve!: (value: ExternalHistoryPage) => void
  const update = vi.fn()
  const feed = createExternalHistoryFeed({
    read: () =>
      new Promise((r) => {
        resolve = r
      }),
    subscribe: () => () => {},
    update,
    error: () => {},
  })
  const task = feed.start()
  await Promise.resolve()
  feed.dispose()
  resolve({
    entries: [entry('old')],
    before: 'old',
    after: 'old',
    hasBefore: false,
    hasAfter: false,
  })
  await task
  expect(update).not.toHaveBeenCalled()
})
it('prepends older pages without moving the persistent catchup cursor', async () => {
  const pages: ExternalHistoryPage[] = []
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      entries: [entry('b')],
      before: 'b',
      after: 'b',
      hasBefore: true,
      hasAfter: false,
    })
    .mockResolvedValueOnce({
      entries: [],
      before: 'b',
      after: 'b',
      hasBefore: true,
      hasAfter: false,
    })
    .mockResolvedValueOnce({
      entries: [entry('a')],
      before: 'a',
      after: 'a',
      hasBefore: false,
      hasAfter: true,
    })
    .mockResolvedValueOnce({
      entries: [entry('c')],
      before: 'c',
      after: 'c',
      hasBefore: true,
      hasAfter: false,
    })
  const feed = createExternalHistoryFeed({
    read,
    subscribe: () => () => {},
    update: (p) => pages.push(p),
    error: (e) => {
      throw e
    },
  })
  await feed.start()
  await feed.older()
  await feed.refresh()
  expect(read.mock.calls[2]?.[0]).toEqual({ before: 'b' })
  expect(read.mock.calls[3]?.[0]).toEqual({ after: 'b' })
  expect(pages.at(-1)).toMatchObject({
    entries: [entry('a'), entry('b'), entry('c')],
    before: 'a',
    after: 'c',
    hasBefore: false,
  })
  feed.dispose()
})
