// FIX-04 (UI-14): streaming into a long session republishes only the
// streaming row. The snapshot and its scalar refs (running, turnCount,
// planSummary) stay put while only the answer's text grows; they move when
// the answer's shape or the window's facts change, and always converge to a
// full replay.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, watch } from 'vue'
import type { SessionEventBatch } from '../api/backend'
import { planSummary } from './planSummary'
import { ConversationStore, type ConversationScheduler } from './store'
import { replay, settle, structural } from './testing/fixtures'
import {
  longMarkdownReply,
  longSessionLog,
  streamChunks,
} from './testing/streaming'

class ManualScheduler implements ConversationScheduler {
  frames: Array<() => void> = []
  microtasks: Array<() => void> = []
  frame(callback: () => void): void {
    this.frames.push(callback)
  }
  microtask(callback: () => void): void {
    this.microtasks.push(callback)
  }
  run(): void {
    while (this.frames.length > 0 || this.microtasks.length > 0) {
      const pending = [...this.microtasks, ...this.frames]
      this.microtasks = []
      this.frames = []
      for (const callback of pending) callback()
    }
  }
}

async function openLong(turns: number) {
  const session = longSessionLog(turns)
  const log: WireSessionEvent[] = [...session.events]
  const scheduler = new ManualScheduler()
  const listeners: Array<(batch: SessionEventBatch) => void> = []
  const store = new ConversationStore({
    api: {
      history: async () => ({
        header: { version: 0, id: 'long', createdAt: 0 },
        events: [...log],
        hasMore: false,
        lastSeq: log.at(-1)?.seq ?? -1,
      }),
    },
    watch: vi.fn(async () => undefined),
    subscribe: (listener) => {
      listeners.push(listener)
      return () => undefined
    },
    scheduler,
    pageMessages: 1_000_000,
  })
  const handle = store.open('long')
  await settle(20)
  scheduler.run()
  const emit = (events: WireSessionEvent[]): void => {
    log.push(...events)
    for (const listener of listeners) listener({ sessionId: 'long', events })
    scheduler.run()
  }
  return { session, handle, emit, log, store }
}

function track(handle: Awaited<ReturnType<typeof openLong>>['handle']) {
  const triggers = new Map<string, number>()
  const scope = effectScope()
  const streamKey = handle.order.value.at(-1) as string
  const otherKey = handle.order.value[3] as string
  scope.run(() => {
    const add = (name: string, source: () => unknown): void => {
      triggers.set(name, 0)
      watch(source, () => triggers.set(name, (triggers.get(name) ?? 0) + 1), {
        flush: 'sync',
      })
    }
    add('snapshot', () => handle.snapshot.value)
    add('order', () => handle.order.value)
    add('window', () => handle.window.value)
    add('running', () => handle.running.value)
    add('turnCount', () => handle.turnCount.value)
    add('planSummary', () => handle.planSummary.value)
    add('stream node', () => handle.node(streamKey).value)
    add('other node', () => handle.node(otherKey).value)
  })
  return { triggers, scope, streamKey }
}

describe('streaming into a 500-turn session (FIX-04)', () => {
  it('3 · republishes only the streaming row for 1000 deltas', async () => {
    const { session, handle, emit } = await openLong(500)
    expect(handle.window.value.openState).toBe('open')
    expect(handle.turnCount.value).toBe(501)
    expect(handle.running.value).toBe(true)
    expect(handle.planSummary.value?.title).toBe('缓存重构计划')
    expect(handle.order.value.length).toBeGreaterThan(1700)
    // The first text shows the answer row (one structural change).
    const chunks = streamChunks(session, longMarkdownReply(8_000), 8)
    expect(chunks.length).toBeGreaterThan(1000)
    emit([chunks[0]!])
    const { triggers, scope, streamKey } = track(handle)
    expect(handle.node(streamKey).value?.kind).toBe('assistant')

    for (const chunk of chunks.slice(1, 1001)) emit([chunk])
    scope.stop()

    expect(Object.fromEntries(triggers)).toEqual({
      snapshot: 0,
      order: 0,
      window: 0,
      running: 0,
      turnCount: 0,
      planSummary: 0,
      'stream node': 1000,
      'other node': 0,
    })
  })

  it('republishes the snapshot when the answer changes shape, and converges to a replay', async () => {
    const { session, handle, emit, log } = await openLong(60)
    const turn = session.openTurn
    emit(streamChunks(session, 'Working', 7))
    const { triggers, scope } = track(handle)
    emit(streamChunks(session, ' on it. ', 4))
    expect(triggers.get('snapshot')).toBe(0)

    // A tool call block starts: the row set changes (a live process row).
    const next = (type: string, data: unknown): WireSessionEvent => {
      const event = {
        type,
        seq: session.nextSeq++,
        time: (session.time += 50),
        data,
      } as unknown as WireSessionEvent
      return event
    }
    emit([
      next('assistant/chunk', {
        turn,
        step: 1,
        chunk: { type: 'block-start', index: 1, blockType: 'tool-call' },
      }),
    ])
    expect(triggers.get('snapshot')).toBe(1)
    emit([
      next('assistant/chunk', {
        turn,
        step: 1,
        chunk: {
          type: 'tool-call-delta',
          index: 1,
          id: 'call_plan_2',
          name: 'exit_plan_mode',
          argumentsDelta: '{"plan":"# 第二版计划\\n\\n1. 收尾"}',
        },
      }),
    ])
    const shaped = triggers.get('snapshot') ?? 0
    expect(shaped).toBe(2)
    emit([
      next('assistant/message', {
        turn,
        step: 1,
        message: {
          id: `assistant-${turn}-1`,
          role: 'assistant',
          content: [
            { type: 'text', text: 'Working on it. ' },
            {
              type: 'tool-call',
              id: 'call_plan_2',
              name: 'exit_plan_mode',
              arguments: '{"plan":"# 第二版计划\\n\\n1. 收尾"}',
            },
          ],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' },
        },
        usage: { inputTokens: 9000, outputTokens: 30 },
      }),
      next('tool/call', {
        turn,
        step: 1,
        callId: 'call_plan_2',
        name: 'exit_plan_mode',
        arguments: '{"plan":"# 第二版计划\\n\\n1. 收尾"}',
      }),
      next('todo/write', {
        todos: [{ content: '收尾', status: 'in_progress' }],
      }),
    ])
    expect(handle.planSummary.value).toMatchObject({
      callId: 'call_plan_2',
      title: '第二版计划',
      status: 'reviewing',
    })
    emit([
      next('step/end', { turn, step: 1 }),
      next('turn/end', { turn, reason: { kind: 'completed' } }),
    ])
    scope.stop()
    expect(handle.running.value).toBe(false)
    expect(triggers.get('running')).toBe(1)
    expect(triggers.get('planSummary')).toBeGreaterThanOrEqual(1)

    // Incremental facts equal a full replay of the same log.
    const full = replay(log).snapshot
    const live = handle.snapshot.value
    expect(structural(live)).toEqual(structural(full))
    expect(live.planSummary).toEqual(full.planSummary)
    expect(live.contextUsage).toEqual(full.contextUsage)
    // The precomputed summary is what a scan of the window finds.
    expect(live.planSummary).toEqual(
      planSummary({ ...live, planSummary: undefined }),
    )
  })
})
