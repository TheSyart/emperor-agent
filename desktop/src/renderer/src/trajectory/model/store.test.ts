// The trajectory target is lazy in the conversation store: chat windows do
// not assemble it until a view activates it, after which live events keep it
// current.
import { describe, expect, it, vi } from 'vitest'
import { effectScope, watch } from 'vue'
import type { SessionEventBatch } from '../../api/backend'
import {
  ConversationStore,
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

function setup(log: LogBuilder) {
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
    lazyTargets: { [TRAJECTORY_TARGET]: TRAJECTORY_EXTENSIONS },
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
      ['Message', ['user']],
      ['Step 1', ['message', 'tool']],
      ['Step 2', ['message']],
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
