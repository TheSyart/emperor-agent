// Golden over the recorded kernel log (packages/core harness projection
// fixture): ledger groups/records, request numbering, usage totals and
// timeline lanes; plus incremental append / older-page prepend converging to
// a full rebuild over the kernel log and the recorded dsh scenarios.
import { describe, expect, it } from 'vitest'
import { deepEqual } from '../../conversation/assembler'
import { chatSnapshotOf } from '../../conversation/chatSnapshot'
import { loadKernelLog } from '../../conversation/testing/fixtures'
import { loadScenario } from '../../conversation/testing/scenario'
import { createTrajectoryAssembler, trajectorySnapshotOf } from './extension'
import { deriveTrajectoryTimeline } from './timeline'
import {
  describeLayout,
  replayTrajectory,
  streamTrajectory,
} from './testing/fixtures'
import { deriveTrajectoryViewModel } from './viewModel'

const SCENARIOS = [
  'fresh-round-trip',
  'steering',
  'plan-review',
  'approval-composer',
]

describe('trajectory over the recorded kernel log', () => {
  const log = loadKernelLog()

  it('lays out the root session into Turn → group → records', () => {
    const { snapshot } = replayTrajectory(log.root.events)
    expect(describeLayout(deriveTrajectoryViewModel(snapshot).turns)).toEqual([
      '== Turn 1',
      '-- Message (1,300 ms)',
      '#1 system: Initial System Prompt',
      '#2 context: Permission preset | workspace-write',
      '#3 context: Sandbox mode | workspace-write',
      '#4 context: Approval policy | ask',
      '#5 context: Inbox · next-turn | queued 1 pick a color',
      '#6 context: Inbox · next-turn | admitted 1',
      '#7 user: | pick a color (shown)',
      '#8 context: | Current runtime context. This snapshot s',
      '#9 context: | <system-reminder> Long-term memory the u',
      '-- Step 1 (400 ms bash×2)',
      '#10 message: | Checking.',
      '#11 tool: bash | {"command":"echo alpha","description":"p',
      '#12 tool: bash | {"command":"echo beta","description":"pr',
      '-- Step 2 (400 ms ask_user_question)',
      '#13 message: Tool call only',
      '#14 tool: ask_user_question | {"questions":[{"id":"color","question":"',
      '-- Step 3 (400 ms subagent)',
      '#15 message: Tool call only',
      '#16 tool: subagent | {"description":"research","prompt":"find',
      '-- Step 4 (800 ms)',
      '#17 message: | Blue it is.',
      '== Between turns',
      '-- Compaction 75 (300 ms)',
      '#18 compacted: | Summary: the user picked blue.',
    ])
  })

  it('fills record details: prompt, user display, tools, subagent, timing', () => {
    const { snapshot } = replayTrajectory(log.root.events)
    const cells = deriveTrajectoryViewModel(snapshot).turns.flatMap((turn) =>
      turn.groups.flatMap((group) => group.cells),
    )
    const byIndex = (index: number) =>
      cells.find((cell) => cell.index === index)
    expect(byIndex(1)?.promptDetail?.system).toContain('Emperor Agent')
    expect(byIndex(1)?.promptDetail?.tools.length).toBeGreaterThan(0)
    expect(byIndex(7)).toMatchObject({
      displayText: 'pick a color (shown)',
      inputDetail: 'pick a color',
      opensTurn: true,
    })
    expect(byIndex(10)).toMatchObject({
      input: 120,
      output: 40,
      cacheRead: 30,
      thinkingDetail: 'I should look first.',
      outputDetail: 'Checking.',
      assistantMetrics: { timingRecorded: true, usageProvided: true },
    })
    expect(byIndex(11)).toMatchObject({
      callId: 'call_bash_a',
      resultPreviewMarkdown: 'alpha\n',
      isError: false,
    })
    expect(byIndex(11)?.schemaDetail).toContain('"name": "bash"')
    expect(byIndex(16)).toMatchObject({
      callId: 'call_delegate',
      subagent: {
        status: 'settled',
        stopReason: 'completed',
        text: 'child found x',
      },
    })
    expect(byIndex(16)?.childSessionId).toBe(log.children[0]?.header.id)
    expect(byIndex(18)).toMatchObject({
      kind: 'compacted',
      input: 10,
      output: 5,
    })
  })

  it('numbers every request and accumulates usage', () => {
    const { snapshot } = replayTrajectory(log.root.events)
    const numbers = deriveTrajectoryViewModel(snapshot).requestNumbers
    expect(
      numbers.map((request) => [
        request.number,
        request.purpose ?? 'assistant',
        request.turn,
        request.group,
        request.status,
      ]),
    ).toEqual([
      [1, 'assistant', 1, 'Step 1', 'complete'],
      [2, 'assistant', 1, 'Step 2', 'complete'],
      [3, 'assistant', 1, 'Step 3', 'complete'],
      [4, 'assistant', 1, 'Step 4', 'complete'],
      [5, 'compaction', null, 'Compaction 75', 'complete'],
    ])
    expect(numbers.map((request) => request.usage)).toEqual([
      { input: 120, cacheRead: 30, output: 40 },
      { input: 10, output: 5 },
      { input: 10, output: 5 },
      { input: 200, output: 12 },
      { input: 10, output: 5 },
    ])
    expect(numbers.at(-2)?.cumulativeUsage).toEqual({
      input: 340,
      cacheRead: 30,
      output: 62,
    })
    expect(numbers.at(-1)?.cumulativeUsage).toEqual({
      input: 350,
      cacheRead: 30,
      output: 67,
    })
    expect(numbers[0]).toMatchObject({
      retry: 1,
      maxRetries: 2,
      provider: 'test-route',
      model: 'test-model',
      contextWindow: 100_000,
      requestConfig: { provider: 'test-route', model: 'test-model' },
    })
    expect(snapshot.requests[0]).toMatchObject({
      purpose: 'assistant',
      promptChange: { kind: 'initial' },
      timing: { ttftMs: 1_000, decodeMs: 1_500 },
    })
    expect(snapshot.requests.at(-1)).toMatchObject({
      purpose: 'compaction',
      replacementSeq: 77,
      provenance: { provider: 'test-route', model: 'test-model' },
    })
  })

  it('projects records into input / model / tool lanes', () => {
    const { snapshot } = replayTrajectory(log.root.events)
    const turns = deriveTrajectoryViewModel(snapshot).turns
    const sequence = deriveTrajectoryTimeline(turns)
    expect(sequence?.spans.map((span) => span.lane)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 1, 2, 1, 2, 1, 1,
    ])
    expect(sequence?.turnBoundaries).toEqual([{ turn: 1, time: 0 }])
    const actual = deriveTrajectoryTimeline(turns, 'actual')
    expect(actual?.start).toBe(1_700_000_000_000)
    expect(actual?.end).toBe(1_700_000_007_800)
    const tool = actual?.spans.find((span) => span.index === 11)
    expect(tool).toMatchObject({
      lane: 2,
      start: 1_700_000_003_500,
      end: 1_700_000_003_600,
    })
  })

  it('lays out the delegated child session', () => {
    const child = log.children[0]
    expect(child).toBeDefined()
    const { snapshot } = replayTrajectory(child?.events ?? [])
    expect(describeLayout(deriveTrajectoryViewModel(snapshot).turns)).toEqual([
      '== Turn 1',
      '-- Message (900 ms)',
      '#1 system: Initial System Prompt',
      '#2 context: Sandbox mode | workspace-write · delegation',
      '#3 context: Approval policy | never · delegation',
      '#4 context: Inbox · next-turn | queued 1 find x',
      '#5 context: Inbox · next-turn | admitted 1',
      '#6 context: | find x',
      '#7 context: | Current runtime context. This snapshot s',
      '-- Step 1 (1,300 ms)',
      '#8 message: | child found x',
    ])
  })

  it('incremental append converges to the full rebuild', () => {
    for (const events of [
      log.root.events,
      ...log.children.map((c) => c.events),
    ]) {
      const replayed = replayTrajectory(events).snapshot
      const streamed = streamTrajectory(events).snapshot
      expect(deepEqual(streamed, replayed)).toBe(true)
      expect(
        deepEqual(
          deriveTrajectoryViewModel(streamed),
          deriveTrajectoryViewModel(replayed),
        ),
      ).toBe(true)
    }
  })

  it('an older page prepended to the tail converges to the full rebuild', () => {
    const events = log.root.events
    const cut = 40
    const assembler = createTrajectoryAssembler()
    assembler.replaceWindow(events.slice(cut), true)
    assembler.flush()
    // A tail window starting mid-turn still lays out without throwing.
    expect(
      deriveTrajectoryViewModel(trajectorySnapshotOf(assembler)).turns.length,
    ).toBeGreaterThan(0)
    assembler.prepend(events.slice(0, cut), false)
    assembler.flush()
    expect(
      deepEqual(
        trajectorySnapshotOf(assembler),
        replayTrajectory(events).snapshot,
      ),
    ).toBe(true)
  })

  it('leaves the chat target unchanged when the trajectory is assembled beside it', () => {
    const { assembler } = replayTrajectory(log.root.events)
    const chat = chatSnapshotOf(assembler)
    expect(chat.order.length).toBe(12)
  })
})

describe('trajectory over recorded scenarios', () => {
  for (const name of SCENARIOS) {
    it(`${name}: streaming converges to replay`, () => {
      const events = loadScenario(name)
      const replayed = replayTrajectory(events).snapshot
      const streamed = streamTrajectory(events).snapshot
      expect(deepEqual(streamed, replayed)).toBe(true)
      const model = deriveTrajectoryViewModel(replayed)
      expect(model.turns.length).toBeGreaterThan(0)
      // Every record index is unique and increasing in ledger order.
      const indexes = model.turns.flatMap((turn) =>
        turn.groups.flatMap((group) => group.cells.map((cell) => cell.index)),
      )
      expect(new Set(indexes).size).toBe(indexes.length)
    })
  }
})
