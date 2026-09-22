// Convergence stress: random interleavings of history pages, live batches
// (duplicates, reordering, gaps), gap repairs and older-page loads must end
// in exactly the snapshot of a full replay of the same log.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import { describe, expect, it } from 'vitest'
import { deepEqual } from './assembler'
import { chatSnapshotOf, createConversationAssembler } from './chatSnapshot'
import { SessionWindow } from './sessionWindow'
import {
  FakeHistoryApi,
  LogBuilder,
  loadKernelLog,
  replay,
  settle,
  structural,
} from './testing/fixtures'

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Kernel log followed by a synthetic turn exercising forward links. */
function complexLog(): WireSessionEvent[] {
  const kernel = loadKernelLog().root.events
  const log = new LogBuilder((kernel.at(-1)?.seq ?? -1) + 1)
  log.add('turn/start', { turn: 2 })
  log.user('u2', 'build it')
  log.add('hook/invoked', {
    turn: 2,
    point: 'Stop',
    dialect: 'codex',
    handlerId: 'h',
  })
  log.add('step/start', { turn: 2, step: 1 })
  log.chunk(2, 1, { type: 'block-start', index: 0, blockType: 'text' })
  log.chunk(2, 1, { type: 'text-delta', index: 0, text: 'on it' })
  log.message(2, 1, [
    { type: 'text', text: 'on it' },
    { type: 'tool-call', id: 'bg', name: 'bash', arguments: '{}' },
  ])
  log.call(2, 1, 'bg', 'bash', { command: 'make', run_in_background: true })
  log.add('job/started', { jobId: 'j1', kind: 'process', command: 'make' })
  log.add('job/finished', {
    jobId: 'j1',
    kind: 'process',
    command: 'make',
    status: 'failed',
    exitCode: 2,
  })
  log.result(2, 1, 'bg', 'started background job j1', {
    meta: { kind: 'background', jobId: 'j1' },
  })
  log.add('hook/result', {
    turn: 2,
    point: 'Stop',
    handlerId: 'h',
    decision: 'pass',
    durationMs: 3,
  })
  log.add('todo/write', { todos: [{ content: 'x', status: 'pending' }] })
  log.add('step/end', { turn: 2, step: 1 })
  log.add('step/start', { turn: 2, step: 2 })
  log.add('llm/retry', {
    retryId: 'r9',
    turn: 2,
    step: 2,
    provider: 'p',
    mode: 'normal',
    policyKey: 'k',
    retry: 1,
    maxRetries: 2,
    delayMs: 10,
    failure: { message: 'flaky', code: 'SERVER' },
  })
  log.add('llm/retry-started', { retryId: 'r9', turn: 2, step: 2 })
  log.chunk(2, 2, { type: 'block-start', index: 0, blockType: 'reasoning' })
  log.chunk(2, 2, { type: 'reasoning-delta', index: 0, text: 'hmm' })
  log.call(2, 2, 'slow', 'read', { path: 'big' })
  log.add('llm/retry', {
    retryId: 'r10',
    turn: 2,
    step: 2,
    provider: 'p',
    mode: 'normal',
    policyKey: 'k',
    retry: 2,
    maxRetries: 2,
    delayMs: 10,
    failure: { message: 'flaky', code: 'SERVER' },
  })
  log.chunk(2, 2, { type: 'block-start', index: 0, blockType: 'text' })
  log.chunk(2, 2, { type: 'text-delta', index: 0, text: 'half an ans' })
  log.add('turn/end', {
    turn: 2,
    reason: { kind: 'aborted', reason: { kind: 'user' } },
  })
  log.add('turn/start', { turn: 3 })
  log.user('u3', 'again')
  log.add('step/start', { turn: 3, step: 1 })
  log.chunk(3, 1, { type: 'block-start', index: 0, blockType: 'reasoning' })
  log.chunk(3, 1, { type: 'reasoning-delta', index: 0, text: 'thinking' })
  return [...kernel, ...log.events]
}

async function runScenario(
  full: readonly WireSessionEvent[],
  seed: number,
): Promise<void> {
  const random = mulberry32(seed)
  const pick = (max: number): number => Math.floor(random() * max)
  let produced = 1 + pick(full.length)
  const api = new FakeHistoryApi(full.slice(0, produced))
  const assembler = createConversationAssembler()
  const window = new SessionWindow('s', api, assembler, {
    pageMessages: 2 + pick(15),
    onWarning: () => {},
  })
  // Live delivery lags the host log; start somewhere before the cut.
  let delivered = pick(produced)
  const deliver = (): void => {
    if (delivered >= produced) return
    const size = 1 + pick(6)
    const batch = full.slice(delivered, Math.min(produced, delivered + size))
    delivered += batch.length
    const mutated = [...batch]
    if (random() < 0.3 && mutated.length > 1) mutated.reverse()
    if (random() < 0.3) mutated.push(...batch.slice(0, 1 + pick(batch.length)))
    if (random() < 0.15 && mutated.length > 1)
      mutated.splice(pick(mutated.length), 1)
    if (random() < 0.2 && delivered > 3)
      mutated.unshift(full[pick(delivered)] as WireSessionEvent)
    window.acceptLive(mutated)
  }
  const grow = (): void => {
    produced = Math.min(full.length, produced + 1 + pick(8))
    api.log = full.slice(0, produced)
  }

  if (random() < 0.5) api.hold()
  const opened = window.open()
  for (let index = pick(4); index > 0; index--) {
    grow()
    deliver()
  }
  api.release()
  await opened
  for (let round = 0; round < 60; round++) {
    const roll = random()
    if (roll < 0.4) grow()
    else if (roll < 0.8) deliver()
    else if (roll < 0.9) await window.loadOlder()
    else await settle(3)
    if (random() < 0.3) assembler.flush()
  }
  // Drain: the host log completes and every event is eventually delivered.
  produced = full.length
  api.log = [...full]
  while (delivered < produced) deliver()
  window.acceptLive(full.slice(-1))
  await settle(50)
  // Incremental path: equal to a from-scratch assembly of the same window.
  assembler.flush()
  const windowReplay = createConversationAssembler()
  windowReplay.replaceWindow(window.window, window.snapshot.hasMore)
  windowReplay.flush()
  const incremental = structural(chatSnapshotOf(assembler))
  const rebuilt = structural(chatSnapshotOf(windowReplay))
  if (!deepEqual(incremental, rebuilt)) expect(incremental).toEqual(rebuilt)
  for (let guard = 0; guard < 200 && window.snapshot.hasMore; guard++)
    await window.loadOlder()
  assembler.flush()
  expect(window.window.map((event) => event.seq)).toEqual(
    full.map((event) => event.seq),
  )
  const expected = structural(replay(full).snapshot)
  const actual = structural(chatSnapshotOf(assembler))
  if (!deepEqual(actual, expected)) expect(actual).toEqual(expected)
}

describe('live/history convergence', () => {
  const full = complexLog()

  it('replays the complex log deterministically', () => {
    const first = structural(replay(full).snapshot)
    const again = structural(replay(full).snapshot)
    expect(deepEqual(first, again)).toBe(true)
  })

  it('converges to the full replay under random interleavings', async () => {
    for (let seed = 1; seed <= 150; seed++) {
      try {
        await runScenario(full, seed)
      } catch (error) {
        throw new Error(`seed ${seed}: ${String(error)}`, { cause: error })
      }
    }
  })
})
