import { describe, expect, it, vi } from 'vitest'
import { effectScope, watch } from 'vue'
import type { SessionEventBatch } from '../api/backend'
import {
  ConversationStore,
  useConversation,
  type ConversationScheduler,
} from './store'
import { FakeHistoryApi, LogBuilder, settle } from './testing/fixtures'

class ManualScheduler implements ConversationScheduler {
  frames: Array<() => void> = []
  microtasks: Array<() => void> = []
  frame(callback: () => void): void {
    this.frames.push(callback)
  }
  microtask(callback: () => void): void {
    this.microtasks.push(callback)
  }
  runFrames(): number {
    const pending = this.frames
    this.frames = []
    for (const callback of pending) callback()
    return pending.length
  }
  runMicrotasks(): number {
    const pending = this.microtasks
    this.microtasks = []
    for (const callback of pending) callback()
    return pending.length
  }
}

function inProgressLog(): LogBuilder {
  const log = new LogBuilder()
  log.add('turn/start', { turn: 1 })
  log.user('u1', 'hello')
  log.add('step/start', { turn: 1, step: 1 })
  log.message(1, 1, [
    { type: 'text', text: 'running tool' },
    { type: 'tool-call', id: 't1', name: 'read', arguments: '{}' },
  ])
  log.call(1, 1, 't1', 'read', { path: 'a' })
  log.result(1, 1, 't1', 'content')
  log.add('step/end', { turn: 1, step: 1 })
  log.add('step/start', { turn: 1, step: 2 })
  log.chunk(1, 2, { type: 'block-start', index: 0, blockType: 'text' })
  log.chunk(1, 2, { type: 'text-delta', index: 0, text: 'str' })
  return log
}

function setup(log: LogBuilder, capacity?: number) {
  const scheduler = new ManualScheduler()
  const apis = new Map<string, FakeHistoryApi>()
  const listeners: Array<(batch: SessionEventBatch) => void> = []
  const watch = vi.fn(async (_ids: readonly string[]) => undefined)
  const store = new ConversationStore({
    api: {
      history: (query) => {
        let api = apis.get(query.sessionId)
        if (api === undefined) {
          api = new FakeHistoryApi(
            query.sessionId === 's1' ? [...log.events] : [],
          )
          apis.set(query.sessionId, api)
        }
        return api.history(query)
      },
    },
    watch,
    subscribe: (listener) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
    scheduler,
    ...(capacity === undefined ? {} : { capacity }),
  })
  const emit = (sessionId: string, events: LogBuilder['events']): void => {
    for (const listener of listeners) listener({ sessionId, events })
  }
  return { store, scheduler, watch, emit, listeners }
}

async function openSettled(
  context: ReturnType<typeof setup>,
  sessionId: string,
) {
  const handle = context.store.open(sessionId)
  await settle(20)
  context.scheduler.runMicrotasks()
  return handle
}

describe('ConversationStore', () => {
  it('re-renders only the changed node on a streaming delta', async () => {
    const log = inProgressLog()
    const context = setup(log)
    const handle = await openSettled(context, 's1')
    expect(handle.window.value.openState).toBe('open')
    const keys = handle.order.value
    expect(keys).toHaveLength(4)
    const [userKey, , toolKey, streamKey] = keys as [
      string,
      string,
      string,
      string,
    ]
    expect(handle.node(streamKey).value?.kind).toBe('assistant')

    const triggers = new Map<string, number>()
    const scope = effectScope()
    scope.run(() => {
      const track = (name: string, source: () => unknown): void => {
        triggers.set(name, 0)
        watch(source, () => triggers.set(name, (triggers.get(name) ?? 0) + 1), {
          flush: 'sync',
        })
      }
      track('order', () => handle.order.value)
      track('user', () => handle.node(userKey).value)
      track('tool', () => handle.node(toolKey).value)
      track('stream', () => handle.node(streamKey).value)
    })

    // Three deltas inside one frame publish once.
    context.emit('s1', [
      log.chunk(1, 2, { type: 'text-delta', index: 0, text: 'ea' }),
      log.chunk(1, 2, { type: 'text-delta', index: 0, text: 'mi' }),
    ])
    context.emit('s1', [
      log.chunk(1, 2, { type: 'text-delta', index: 0, text: 'ng' }),
    ])
    expect(context.scheduler.microtasks).toHaveLength(0)
    expect(context.scheduler.runFrames()).toBe(1)
    expect(Object.fromEntries(triggers)).toEqual({
      order: 0,
      user: 0,
      tool: 0,
      stream: 1,
    })
    const streaming = handle.node(streamKey).value
    expect(streaming?.kind === 'assistant' && streaming.data.blocks).toEqual([
      { kind: 'text', text: 'streaming' },
    ])

    // usage/finish chunks publish nothing.
    context.emit('s1', [
      log.chunk(1, 2, {
        type: 'usage',
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    ])
    expect(context.scheduler.frames).toHaveLength(0)
    expect(context.scheduler.microtasks).toHaveLength(0)

    // Settling the message changes the assistant row only (anchor moves).
    context.emit('s1', [
      log.message(1, 2, [{ type: 'text', text: 'streaming' }]),
    ])
    expect(context.scheduler.runMicrotasks()).toBe(1)
    expect(triggers.get('stream')).toBe(2)
    expect(triggers.get('user')).toBe(0)
    expect(triggers.get('tool')).toBe(0)
    scope.stop()
  })

  it('evicts least recently used windows but keeps retained ones', async () => {
    const context = setup(new LogBuilder(), 2)
    context.store.open('a')
    const release = context.store.retain('a')
    context.store.open('b')
    context.store.open('c')
    expect(context.store.openSessions()).toEqual(['a', 'c'])
    context.store.open('d')
    expect(context.store.openSessions()).toEqual(['a', 'd'])
    release()
    context.store.open('e')
    expect(context.store.openSessions()).toEqual(['d', 'e'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(context.watch.mock.calls.at(-1)?.[0]).toEqual(['d', 'e'])
    expect(context.listeners).toHaveLength(1)
  })

  it('routes live batches only to open windows', async () => {
    const log = inProgressLog()
    const context = setup(log)
    const handle = await openSettled(context, 's1')
    const before = handle.order.value
    context.emit('other', [log.add('turn/start', { turn: 9 })])
    expect(context.scheduler.frames).toHaveLength(0)
    expect(context.scheduler.microtasks).toHaveLength(0)
    expect(handle.order.value).toBe(before)
  })

  it('retains through useConversation until the scope stops', async () => {
    const context = setup(inProgressLog(), 1)
    const scope = effectScope()
    const handle = scope.run(() => useConversation('s1', context.store))
    expect(handle?.sessionId).toBe('s1')
    context.store.open('x')
    expect(context.store.openSessions()).toEqual(['s1', 'x'])
    scope.stop()
    expect(context.store.openSessions()).toEqual(['x'])
  })
})
