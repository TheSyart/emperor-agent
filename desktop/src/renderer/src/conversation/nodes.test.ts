import { describe, expect, it } from 'vitest'
import { deepEqual } from './assembler'
import { chatSnapshotOf, createConversationAssembler } from './chatSnapshot'
import {
  describeNodes,
  LogBuilder,
  nodeOf,
  replay,
  stream,
  structural,
} from './testing/fixtures'

function expectConverges(log: LogBuilder): void {
  const replayed = replay(log.events).snapshot
  const streamed = stream(log.events).snapshot
  expect(deepEqual(structural(streamed), structural(replayed))).toBe(true)
}

describe('assistant streaming', () => {
  it('folds chunks into blocks and publishes deltas per frame', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    const assembler = createConversationAssembler()
    assembler.replaceWindow(log.events, false)
    assembler.flush()
    expect(chatSnapshotOf(assembler).running).toBe(true)
    expect(chatSnapshotOf(assembler).turnStatus?.turn).toBe(1)

    const steps: Array<[unknown, string]> = [
      [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        'animation-frame',
      ],
      [{ type: 'reasoning-delta', index: 0, text: 'think' }, 'animation-frame'],
      [{ type: 'block-start', index: 1, blockType: 'text' }, 'animation-frame'],
      [{ type: 'text-delta', index: 1, text: 'Hel' }, 'animation-frame'],
      [{ type: 'text-delta', index: 1, text: 'lo' }, 'animation-frame'],
      [
        { type: 'block-start', index: 2, blockType: 'tool-call' },
        'animation-frame',
      ],
      [
        {
          type: 'tool-call-delta',
          index: 2,
          id: 'c1',
          name: 'bash',
          argumentsDelta: '{"co',
        },
        'animation-frame',
      ],
      [{ type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } }, 'none'],
    ]
    for (const [chunk, publication] of steps) {
      expect(assembler.append(log.chunk(1, 1, chunk))).toBe(publication)
    }
    assembler.flush()
    const running = nodeOf(chatSnapshotOf(assembler), 'assistant')
    expect(running.data.status).toBe('running')
    expect(running.data.blocks).toEqual([
      { kind: 'reasoning', text: 'think' },
      { kind: 'text', text: 'Hello' },
      { kind: 'tool-call', callId: 'c1', name: 'bash' },
    ])
    expect(running.data.usage).toEqual({ inputTokens: 5, outputTokens: 7 })

    expect(
      assembler.append(
        log.message(1, 1, [
          { type: 'reasoning', text: 'think' },
          { type: 'text', text: 'Hello' },
        ]),
      ),
    ).toBe('immediate')
    assembler.flush()
    const settled = nodeOf(chatSnapshotOf(assembler), 'assistant')
    expect(settled.data.status).toBe('settled')
    expect(settled.data.timing?.firstTokenTime).not.toBeNull()
    expect(settled.anchorSeq).toBe(log.events.at(-1)?.seq)
  })

  it('discards the failed attempt on llm/retry and shows the retry row', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.chunk(1, 1, { type: 'block-start', index: 0, blockType: 'text' })
    log.chunk(1, 1, { type: 'text-delta', index: 0, text: 'broken answ' })
    log.chunk(1, 1, {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } },
    })
    log.add('llm/retry', {
      retryId: 'r1',
      turn: 1,
      step: 1,
      provider: 'p',
      mode: 'normal',
      policyKey: 'k',
      retry: 1,
      maxRetries: 3,
      delayMs: 2000,
      failure: { message: 'boom', code: 'SERVER', status: 503 },
    })
    let { snapshot } = replay(log.events)
    expect(describeNodes(snapshot)).toEqual(['retry: 1:scheduled'])
    expect(nodeOf(snapshot, 'retry').data.current).toMatchObject({
      delayMs: 2000,
      message: 'boom (503)',
    })

    log.add('llm/retry-started', { retryId: 'r1', turn: 1, step: 1 })
    log.chunk(1, 1, { type: 'block-start', index: 0, blockType: 'text' })
    log.chunk(1, 1, { type: 'text-delta', index: 0, text: 'good' })
    log.message(1, 1, [{ type: 'text', text: 'good' }])
    snapshot = replay(log.events).snapshot
    expect(describeNodes(snapshot)).toEqual([
      'retry: 1:started',
      'assistant[settled]: text=good',
    ])
    expectConverges(log)
  })

  it('cancels a scheduled retry when the step closes first', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.add('llm/retry', {
      retryId: 'r1',
      turn: 1,
      step: 1,
      provider: 'p',
      mode: 'always',
      policyKey: 'k',
      retry: 1,
      delayMs: 5000,
      failure: { message: 'rate', code: 'RATE_LIMIT' },
    })
    log.add('step/end', { turn: 1, step: 1 })
    log.add('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    expect(describeNodes(replay(log.events).snapshot)).toEqual([
      'retry: 1:cancelled',
    ])
  })
})

describe('interruption', () => {
  it('freezes the partial assistant and running tools when the turn aborts', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.user('u1', 'go')
    log.add('step/start', { turn: 1, step: 1 })
    log.message(1, 1, [
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    ])
    log.call(1, 1, 'c1', 'bash', { command: 'sleep 100' })
    log.add('step/end', { turn: 1, step: 1 })
    log.add('step/start', { turn: 1, step: 2 })
    log.chunk(1, 2, { type: 'block-start', index: 0, blockType: 'text' })
    log.chunk(1, 2, { type: 'text-delta', index: 0, text: 'partial' })
    const before = replay(log.events).snapshot
    expect(before.running).toBe(true)
    expect(describeNodes(before)).toEqual([
      'user: go',
      'tool[interrupted]: bash',
      'assistant[running]: text=partial',
    ])
    const end = log.add('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    const after = replay(log.events).snapshot
    expect(after.running).toBe(false)
    expect(describeNodes(after)).toEqual([
      'user: go',
      'tool[interrupted]: bash',
      'assistant[interrupted]: text=partial',
    ])
    expect(nodeOf(after, 'assistant').anchorSeq).toBeCloseTo(end.seq - 0.9)
    expectConverges(log)
  })

  it('marks a crash-repaired turn interrupted and a live tool running', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.call(1, 1, 'c1', 'read', {})
    expect(nodeOf(replay(log.events).snapshot, 'tool').data.status).toBe(
      'running',
    )
    log.add('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    expect(nodeOf(replay(log.events).snapshot, 'tool').data.status).toBe(
      'interrupted',
    )
  })
})

describe('tools', () => {
  it('keeps parallel calls in call order with their own results', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.call(1, 1, 'a', 'read', { path: 'a' })
    log.call(1, 1, 'b', 'read', { path: 'b' })
    log.result(1, 1, 'b', 'B!')
    log.result(1, 1, 'a', 'A!', { isError: true })
    const { snapshot } = replay(log.events)
    expect(describeNodes(snapshot)).toEqual([
      'tool[settled]: read',
      'tool[settled]: read',
    ])
    expect(nodeOf(snapshot, 'tool', 0).data).toMatchObject({
      callId: 'a',
      argsRaw: '{"path":"a"}',
      result: { isError: true, content: [{ type: 'text', text: 'A!' }] },
    })
    expect(nodeOf(snapshot, 'tool', 1).data.result?.content).toEqual([
      { type: 'text', text: 'B!' },
    ])
    expectConverges(log)
  })

  it('settles a background subagent after its call result', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.call(1, 1, 'd', 'subagent', { description: 'bg' })
    log.add('subagent/started', {
      subagentId: 'sub-1',
      description: 'bg',
      mode: 'spawn',
      background: true,
      callId: 'd',
    })
    log.result(1, 1, 'd', 'started sub-1')
    log.add('step/end', { turn: 1, step: 1 })
    log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    let tool = nodeOf(replay(log.events).snapshot, 'tool')
    expect(tool.data.subagent).toMatchObject({
      subagentId: 'sub-1',
      background: true,
      status: 'running',
    })
    log.add('subagent/settled', {
      subagentId: 'sub-1',
      stopReason: 'completed',
      text: 'done',
    })
    tool = nodeOf(replay(log.events).snapshot, 'tool')
    expect(tool.data.subagent).toMatchObject({
      status: 'settled',
      text: 'done',
    })
    expectConverges(log)
  })

  it('attaches a background job even when it finishes before the result', () => {
    for (const early of [true, false]) {
      const log = new LogBuilder()
      log.add('turn/start', { turn: 1 })
      log.add('step/start', { turn: 1, step: 1 })
      log.call(1, 1, 'j', 'bash', { command: 'make', run_in_background: true })
      log.add('job/started', {
        jobId: 'job-1',
        kind: 'process',
        command: 'make',
      })
      const finished = {
        jobId: 'job-1',
        kind: 'process',
        command: 'make',
        status: 'completed',
        exitCode: 0,
      }
      if (early) log.add('job/finished', finished)
      log.result(1, 1, 'j', 'started background job job-1', {
        meta: { kind: 'background', jobId: 'job-1' },
      })
      if (!early) {
        expect(nodeOf(replay(log.events).snapshot, 'tool').data.job).toEqual({
          jobId: 'job-1',
          status: 'running',
        })
        log.add('job/finished', finished)
      }
      expect(nodeOf(replay(log.events).snapshot, 'tool').data.job).toEqual({
        jobId: 'job-1',
        status: 'completed',
        exitCode: 0,
      })
      expectConverges(log)
    }
  })

  it('attaches approval escalations to the call', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.call(1, 1, 'w', 'bash', { command: 'touch x' })
    log.add('approval/asked', {
      id: 'ap1',
      toolName: 'bash',
      callId: 'w',
      reason: 'escalate sandbox',
    })
    expect(describeNodes(replay(log.events).snapshot)).toEqual([
      'tool[running]: bash approvals=pending',
    ])
    log.add('approval/decided', { id: 'ap1', outcome: 'allowed-once' })
    log.result(1, 1, 'w', '')
    const tool = nodeOf(replay(log.events).snapshot, 'tool')
    expect(tool.data.approvals).toEqual([
      {
        id: 'ap1',
        toolName: 'bash',
        reason: 'escalate sandbox',
        outcome: 'allowed-once',
      },
    ])
  })

  it('builds workflow runs inside the tool row or standalone', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.call(1, 1, 'wf', 'workflow', { script: 'x' })
    log.add('tool-workflow/run-start', {
      runId: 'run-1',
      name: 'review',
      tool: 'workflow',
      callId: 'wf',
    })
    log.add('tool-workflow/phase', { runId: 'run-1', title: 'Explore' })
    log.add('tool-workflow/agent-start', {
      runId: 'run-1',
      seq: 1,
      label: 'scout',
      childId: 'sub-a',
    })
    log.add('tool-workflow/log', { runId: 'run-1', message: 'found 3 files' })
    log.add('tool-workflow/phase', { runId: 'run-1', title: 'Fix' })
    log.add('tool-workflow/agent-start', {
      runId: 'run-1',
      seq: 2,
      label: 'fixer',
      phase: 'Fix',
      childId: 'sub-b',
    })
    log.add('tool-workflow/agent-end', {
      runId: 'run-1',
      seq: 1,
      outcome: 'completed',
    })
    log.add('tool-workflow/agent-end', {
      runId: 'run-1',
      seq: 2,
      outcome: 'failed',
    })
    log.add('tool-workflow/run-end', {
      runId: 'run-1',
      stopReason: 'completed',
      agentsStarted: 2,
      result: 'ok',
    })
    log.result(1, 1, 'wf', 'ok')
    log.add('tool-workflow/run-start', { runId: 'run-2', name: 'nightly' })
    const { snapshot } = replay(log.events)
    expect(describeNodes(snapshot)).toEqual([
      'tool[settled]: workflow',
      'workflowRun[running]: nightly',
    ])
    expect(nodeOf(snapshot, 'tool').data.workflow).toEqual({
      runId: 'run-1',
      name: 'review',
      tool: 'workflow',
      callId: 'wf',
      status: 'completed',
      agentsStarted: 2,
      result: 'ok',
      logs: ['found 3 files'],
      phases: [
        {
          title: 'Explore',
          members: [
            { seq: 1, label: 'scout', childId: 'sub-a', outcome: 'completed' },
          ],
        },
        {
          title: 'Fix',
          members: [
            { seq: 2, label: 'fixer', childId: 'sub-b', outcome: 'failed' },
          ],
        },
      ],
    })
    expectConverges(log)
  })
})

describe('messages and notices', () => {
  it('classifies steering, hides uiHidden messages, and shows context', () => {
    const log = new LogBuilder()
    log.add('host/user-meta', { messageId: 'u1', displayContent: 'shown text' })
    log.add('turn/start', { turn: 1 })
    log.user('u1', 'model text')
    log.add('instructions/baseline', { digest: 'x', files: ['AGENTS.md'] })
    log.add('memory/baseline', { digest: 'y' })
    log.add(
      'user/message',
      {
        id: 'ctx1',
        role: 'user',
        content: [{ type: 'text', text: 'snapshot' }],
        source: {
          kind: 'context',
          producer: 'runtime-context',
          form: 'snapshot',
        },
      },
      { surfaceOp: 'append' },
    )
    log.add('step/start', { turn: 1, step: 1 })
    log.add('agent/inbox/spliced', {
      target: 'next-step',
      start: 0,
      inserted: [
        { id: 'u2', role: 'user', content: [], source: { kind: 'user' } },
      ],
    })
    log.add('agent/inbox/spliced', {
      target: 'next-step',
      start: 0,
      removedCount: 1,
      inserted: [],
    })
    log.user('u2', 'also this')
    log.add('host/user-meta', { messageId: 'u3', uiHidden: true })
    log.user('u3', 'secret nudge')
    const { snapshot } = replay(log.events)
    expect(describeNodes(snapshot)).toEqual([
      'user: shown text',
      'context: instructions AGENTS.md',
      'context: runtime-context',
      'user(steering): also this',
    ])
    const hidden = [...snapshot.nodes.values()].find(
      (node) => node.kind === 'user' && node.data.messageId === 'u3',
    )
    expect(hidden?.visibility).toBe('hidden')
    expectConverges(log)
  })

  it('renders turn-level notices, goal rows, hooks and facts', () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('hook/invoked', {
      turn: 1,
      point: 'PreToolUse',
      dialect: 'claude-code',
      handlerId: 'h:1',
    })
    log.add('hook/result', {
      turn: 1,
      point: 'PreToolUse',
      handlerId: 'h:1',
      decision: 'pass',
      durationMs: 12,
    })
    // A restarted process reuses the handler id; the result pairs with the
    // latest invocation.
    log.add('hook/invoked', {
      turn: 1,
      point: 'Stop',
      dialect: 'claude-code',
      handlerId: 'h:1',
    })
    log.add('step/start', { turn: 1, step: 1 })
    log.add('todo/write', {
      todos: [{ content: 'a', status: 'in_progress' }],
    })
    log.add('llm/fallback', {
      fallbackId: 'f1',
      turn: 1,
      step: 1,
      from: 'primary',
      to: 'backup',
      trigger: 'rate-limit',
      failure: { message: 'slow down', code: 'RATE_LIMIT' },
    })
    log.add('llm/cost-cap', {
      turn: 1,
      step: 1,
      capUsdNanos: 1000,
      spentUsdNanos: 1500,
    })
    log.add('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: {
        id: 'g1',
        revision: 1,
        objective: 'ship it',
        phase: 'active',
        maxGoalRounds: 5,
      },
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    log.add('step/end', { turn: 1, step: 1 })
    log.add('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: { message: 'provider down', code: 'SERVER' },
      },
    })
    log.add('turn/start', { turn: 2 })
    log.add('turn/end', { turn: 2, reason: { kind: 'max-tokens' } })
    log.add('todo/write', { todos: [{ content: 'a', status: 'completed' }] })
    log.add('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'clear',
      cleared: { id: 'g1', revision: 2 },
      clearedAt: 2,
    })
    const { snapshot } = replay(log.events)
    expect(describeNodes(snapshot)).toEqual([
      'hook[done]: PreToolUse',
      'hook[running]: Stop',
      'fallback: primary -> backup',
      'costCap: turn 1',
      'goal: create active',
      'turnError: provider down',
      'turnMaxTokens: turn 2',
      'goal: clear',
    ])
    expect(snapshot.todos).toEqual([{ content: 'a', status: 'completed' }])
    expect(nodeOf(snapshot, 'hook').data).toMatchObject({
      decision: 'pass',
      durationMs: 12,
    })
    expectConverges(log)
  })
})
