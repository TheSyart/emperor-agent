// The trajectory target is lazy in the conversation store: chat windows do
// not assemble it until a view activates it, after which live events keep it
// current; 30 s after its last user leaves it is dropped again (UI-39).
import { describe, expect, it, vi } from 'vitest'
import { effectScope, watch } from 'vue'
import type { SessionEventBatch } from '../../api/backend'
import type { ConversationDefinition } from '../../conversation/assembler'
import type { ConversationExtensions } from '../../conversation/chatSnapshot'
import {
  ConversationStore,
  LAZY_TARGET_IDLE_MS,
  type ConversationScheduler,
} from '../../conversation/store'
import {
  FakeHistoryApi,
  LogBuilder,
  settle,
} from '../../conversation/testing/fixtures'
import type { TrajectorySnapshot } from './contract'
import { TRAJECTORY_EXTENSIONS, TRAJECTORY_TARGET } from './extension'
import { deriveTrajectoryViewModel } from './viewModel'

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
    const pending = [...this.microtasks, ...this.frames]
    this.microtasks = []
    this.frames = []
    for (const callback of pending) callback()
  }
  now = 0
  timers: Array<{ at: number; callback: () => void }> = []
  delay(callback: () => void, ms: number): () => void {
    const timer = { at: this.now + ms, callback }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter((entry) => entry !== timer)
    }
  }
  advance(ms: number): void {
    this.now += ms
    const due = this.timers.filter((timer) => timer.at <= this.now)
    this.timers = this.timers.filter((timer) => timer.at > this.now)
    for (const timer of due) timer.callback()
  }
}

function inProgressLog(): LogBuilder {
  const log = new LogBuilder()
  log.add('turn/start', { turn: 1 })
  log.add('step/start', { turn: 1, step: 1 })
  log.user('u1', 'hello')
  log.message(1, 1, [
    { type: 'text', text: 'running tool' },
    { type: 'tool-call', id: 't1', name: 'read', arguments: '{"path":"a"}' },
  ])
  log.call(1, 1, 't1', 'read', { path: 'a' })
  log.result(1, 1, 't1', 'content')
  log.add('step/end', { turn: 1, step: 1 })
  log.add('step/start', { turn: 1, step: 2 })
  log.chunk(1, 2, { type: 'block-start', index: 0, blockType: 'text' })
  log.chunk(1, 2, { type: 'text-delta', index: 0, text: 'str' })
  return log
}

function setup(
  log: LogBuilder,
  extensions: ConversationExtensions = TRAJECTORY_EXTENSIONS,
) {
  const scheduler = new ManualScheduler()
  const listeners: Array<(batch: SessionEventBatch) => void> = []
  const api = new FakeHistoryApi([...log.events])
  const store = new ConversationStore({
    api: { history: (query) => api.history(query) },
    watch: vi.fn(async () => undefined),
    subscribe: (listener) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
    scheduler,
    lazyTargets: { [TRAJECTORY_TARGET]: extensions },
  })
  const emit = (events: LogBuilder['events']): void => {
    for (const listener of listeners) listener({ sessionId: 's1', events })
  }
  return { store, scheduler, emit }
}

describe('lazy trajectory target', () => {
  it('assembles only chat until activated, then follows live events', async () => {
    const log = inProgressLog()
    const context = setup(log)
    const handle = context.store.open('s1')
    await settle(20)
    context.scheduler.run()
    expect(handle.window.value.openState).toBe('open')
    const chatOrder = handle.order.value

    const revisions: number[] = []
    const scope = effectScope()
    scope.run(() => {
      watch(
        () => handle.revision.value,
        (value) => revisions.push(value),
        { flush: 'sync' },
      )
    })

    handle.activate('trajectory')
    expect(revisions).toHaveLength(1)
    // Chat rows keep their identity across the re-assembly.
    expect(handle.order.value).toBe(chatOrder)
    const first = handle.target<TrajectorySnapshot>('trajectory')
    expect(first?.partial?.blocks).toEqual([{ kind: 'text', text: 'str' }])
    expect(first?.eventNodes.map((node) => node.kind)).toEqual([
      'user',
      'assistant',
      'tool-result',
    ])
    // Activation is idempotent.
    handle.activate('trajectory')
    expect(revisions).toHaveLength(1)

    context.emit([
      log.chunk(1, 2, { type: 'text-delta', index: 0, text: 'eam' }),
      log.message(1, 2, [{ type: 'text', text: 'stream' }]),
      log.add('step/end', { turn: 1, step: 2 }),
    ])
    context.scheduler.run()
    const next = handle.target<TrajectorySnapshot>('trajectory')
    expect(next).not.toBe(first)
    expect(next?.partial).toBeNull()
    const model = deriveTrajectoryViewModel(next as TrajectorySnapshot)
    expect(
      model.turns[0]?.groups.map((group) => [
        group.title,
        group.cells.map((cell) => cell.kind),
      ]),
    ).toEqual([
      ['消息', ['user']],
      ['第 1 步', ['message', 'tool']],
      ['第 2 步', ['message']],
    ])
    expect(model.requestNumbers.map((request) => request.number)).toEqual([
      1, 2,
    ])
    scope.stop()
  })

  it('activates on first target() access and ignores unknown targets', async () => {
    const context = setup(inProgressLog())
    const handle = context.store.open('s1')
    await settle(20)
    context.scheduler.run()
    expect(handle.target('unknown')).toBeUndefined()
    const snapshot = handle.target<TrajectorySnapshot>('trajectory')
    expect(snapshot?.eventNodes.length).toBe(3)
  })
})

describe('trajectory target lifetime (UI-39)', () => {
  /** The trajectory extension plus a probe counting the events it sees. */
  function probed(): {
    extensions: ConversationExtensions
    seen: () => number
  } {
    let count = 0
    const probe: ConversationDefinition = {
      kind: 'probe',
      match: () => {
        count++
        return null
      },
      start: () => undefined,
      update: () => undefined,
    }
    return {
      extensions: {
        definitions: [...(TRAJECTORY_EXTENSIONS.definitions ?? []), probe],
        views: TRAJECTORY_EXTENSIONS.views ?? [],
      },
      seen: () => count,
    }
  }

  it('9 · drops the target 30 s after its last user leaves', async () => {
    const log = inProgressLog()
    const { extensions, seen } = probed()
    const context = setup(log, extensions)
    const handle = context.store.open('s1')
    await settle(20)
    context.scheduler.run()
    const chatOrder = handle.order.value
    expect(handle.hasTarget(TRAJECTORY_TARGET)).toBe(false)

    const release = handle.retainTarget(TRAJECTORY_TARGET)
    expect(handle.hasTarget(TRAJECTORY_TARGET)).toBe(true)
    expect(seen()).toBeGreaterThan(0)
    release()
    release()
    expect(context.scheduler.timers).toHaveLength(1)
    context.scheduler.advance(LAZY_TARGET_IDLE_MS - 1)
    expect(handle.hasTarget(TRAJECTORY_TARGET)).toBe(true)
    context.scheduler.advance(1)
    expect(handle.hasTarget(TRAJECTORY_TARGET)).toBe(false)
    // Chat rows keep their identity across the re-assembly.
    expect(handle.order.value).toBe(chatOrder)

    // Live events no longer reach the trajectory definitions; chat follows.
    const before = seen()
    const chatSnapshot = handle.snapshot.value
    context.emit([
      log.chunk(1, 2, { type: 'text-delta', index: 0, text: 'eam' }),
      log.message(1, 2, [{ type: 'text', text: 'stream' }]),
      log.add('step/end', { turn: 1, step: 2 }),
    ])
    context.scheduler.run()
    expect(seen()).toBe(before)
    expect(handle.snapshot.value).not.toBe(chatSnapshot)

    // Opening the trajectory again catches up with the whole window.
    const again = handle.retainTarget(TRAJECTORY_TARGET)
    const snapshot = handle.target<TrajectorySnapshot>(TRAJECTORY_TARGET)
    expect(snapshot?.partial).toBeNull()
    expect(snapshot?.eventNodes.map((node) => node.kind)).toEqual([
      'user',
      'assistant',
      'tool-result',
      'assistant',
    ])
    again()
  })

  it('keeps the target for a user who comes back within 30 s', async () => {
    const context = setup(inProgressLog())
    const handle = context.store.open('s1')
    await settle(20)
    context.scheduler.run()
    const first = handle.retainTarget(TRAJECTORY_TARGET)
    const second = handle.retainTarget(TRAJECTORY_TARGET)
    first()
    expect(context.scheduler.timers).toHaveLength(0)
    second()
    context.scheduler.advance(LAZY_TARGET_IDLE_MS / 2)
    const back = handle.retainTarget(TRAJECTORY_TARGET)
    expect(context.scheduler.timers).toHaveLength(0)
    context.scheduler.advance(LAZY_TARGET_IDLE_MS)
    expect(handle.hasTarget(TRAJECTORY_TARGET)).toBe(true)
    back()
    context.scheduler.advance(LAZY_TARGET_IDLE_MS)
    expect(handle.hasTarget(TRAJECTORY_TARGET)).toBe(false)
    // Unknown targets have nothing to hold.
    const none = handle.retainTarget('unknown')
    expect(handle.hasTarget('unknown')).toBe(false)
    none()
    expect(context.scheduler.timers).toHaveLength(0)
  })
})
