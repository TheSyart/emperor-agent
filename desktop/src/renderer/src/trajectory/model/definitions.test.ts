// Ported from dsh ui-trajectory tests/conversation-definitions.client.spec.ts,
// adapted to Emperor events (no Code Dispatch: background jobs and workflow
// members become subtools), plus the Emperor-specific mappings.
import { describe, expect, it } from 'vitest'
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import type { ConversationAssembler } from '../../conversation/assembler'
import type {
  TrajectoryContextNode,
  TrajectorySnapshot,
  TrajectoryToolResultNode,
  TrajectoryUserNode,
} from './contract'
import { createTrajectoryAssembler, trajectorySnapshotOf } from './extension'
import { deriveTrajectoryLayout } from './layout'

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): WireSessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type,
    data,
    ...extra,
  } as unknown as WireSessionEvent
}

const APPEND = { surfaceOp: 'append' }

function assembler(events: readonly WireSessionEvent[]): ConversationAssembler {
  const value = createTrajectoryAssembler()
  value.replaceWindow(events, false)
  value.flush()
  return value
}

function snapshot(value: ConversationAssembler): TrajectorySnapshot {
  return trajectorySnapshotOf(value)
}

function assistantMessage(id: string, content: unknown[]) {
  return {
    id,
    role: 'assistant',
    content,
    source: { kind: 'model', provider: 'test', model: 'test' },
  }
}

function toolResult(
  seq: number,
  callId: string,
  text: string,
  extra: Record<string, unknown> = {},
): WireSessionEvent {
  return at(
    seq,
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: `r-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text }],
          },
        ],
      },
      ...extra,
    },
    APPEND,
  )
}

function user(seq: number, id: string, text: string): WireSessionEvent {
  return at(
    seq,
    'user/message',
    {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    APPEND,
  )
}

function contexts(current: TrajectorySnapshot): TrajectoryContextNode[] {
  return current.eventNodes.filter(
    (node): node is TrajectoryContextNode => node.kind === 'context',
  )
}

describe('Trajectory conversation Definitions', () => {
  it('assembles streaming usage, preserves retry facts, and materializes interruption', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'first attempt' },
      }),
      at(4, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      }),
    ])

    expect(snapshot(value).partial?.blocks).toEqual([
      { kind: 'text', text: 'first attempt' },
    ])
    expect(snapshot(value).requests).toMatchObject([
      {
        purpose: 'assistant',
        status: 'running',
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    ])

    value.append(
      at(5, 'llm/retry', {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'test',
        mode: 'normal',
        policyKey: 'test-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 25,
        failure: { code: 'TRANSPORT', message: 'temporary failure' },
      }),
    )
    value.append(
      at(6, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'second attempt' },
      }),
    )
    value.append(at(7, 'step/end', { turn: 1, step: 1 }))
    value.flush()

    const settled = snapshot(value)
    expect(settled.partial).toBeNull()
    expect(settled.eventNodes).toMatchObject([
      {
        kind: 'assistant',
        seq: 6.1,
        interrupted: true,
        blocks: [{ kind: 'text', text: 'second attempt' }],
      },
    ])
    expect(settled.requests).toMatchObject([
      {
        purpose: 'assistant',
        status: 'error',
        retry: 1,
        maxRetries: 2,
        retryDelayMs: 25,
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    ])
  })

  it('classifies a cancellation-finalized prefix as an interrupted request result', () => {
    const current = snapshot(
      assembler([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        at(
          3,
          'assistant/message',
          {
            turn: 1,
            step: 1,
            message: assistantMessage('interrupted-message', [
              { type: 'text', text: 'cut short' },
            ]),
            interrupted: true,
          },
          APPEND,
        ),
        at(4, 'step/end', { turn: 1, step: 1 }),
        at(5, 'turn/end', {
          turn: 1,
          reason: { kind: 'aborted', reason: { kind: 'user' } },
        }),
      ]),
    )

    expect(current.eventNodes).toMatchObject([
      {
        kind: 'assistant',
        seq: 3,
        messageId: 'interrupted-message',
        interrupted: true,
        blocks: [{ kind: 'text', text: 'cut short' }],
      },
    ])
    expect(current.requests).toMatchObject([
      {
        purpose: 'assistant',
        resultSeq: 3,
        status: 'error',
        provenance: { provider: 'test', model: 'test' },
      },
    ])
  })

  it('keeps parallel interrupted roots and nests background jobs as subtools', () => {
    const current = snapshot(
      assembler([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        at(3, 'tool/call', {
          turn: 1,
          step: 1,
          callId: 'root-a',
          name: 'bash',
          arguments: '{"command":"sleep 9","run_in_background":true}',
        }),
        at(4, 'tool/call', {
          turn: 1,
          step: 1,
          callId: 'root-b',
          name: 'read',
          arguments: '{}',
        }),
        // The job registers before the tool returns its background result.
        at(5, 'job/started', {
          jobId: 'job-1',
          kind: 'bash',
          command: 'sleep 9',
        }),
        toolResult(6, 'root-a', 'started job-1', {
          meta: { kind: 'background', jobId: 'job-1' },
        }),
        at(7, 'step/end', { turn: 1, step: 1 }),
        at(8, 'job/finished', {
          jobId: 'job-1',
          kind: 'bash',
          command: 'sleep 9',
          status: 'failed',
          exitCode: 2,
        }),
      ]),
    )

    const tools = current.eventNodes.filter(
      (node): node is TrajectoryToolResultNode => node.kind === 'tool-result',
    )
    expect(tools.map((node) => node.callId).sort()).toEqual([
      'root-a',
      'root-b',
    ])
    expect(tools.find((node) => node.callId === 'root-b')).toMatchObject({
      isError: true,
      error: { code: 'interrupted' },
    })
    const background = tools.find((node) => node.callId === 'root-a')
    expect(background?.job).toMatchObject({
      jobId: 'job-1',
      status: 'failed',
      exitCode: 2,
    })
    expect(background?.subCalls).toMatchObject([
      {
        kind: 'tool-result',
        callId: 'job:job-1',
        call: { name: 'job:bash' },
        isError: true,
        content: [{ type: 'text', text: 'failed · exit code 2' }],
      },
    ])
  })

  it('assembles compaction lifecycle, checkpoint replacement, and orphan interruption', () => {
    const current = snapshot(
      assembler([
        at(1, 'compaction/start', { compactionId: 'complete', turn: null }),
        at(2, 'compaction/summary', {
          compactionId: 'complete',
          summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start: 0, end: 1 },
          shadowedSeqs: [0],
          shadowedTokenCount: 10,
          provider: 'test',
          model: 'test',
          maxTokens: 100,
          usage: { inputTokens: 20, outputTokens: 5 },
        }),
        at(
          3,
          'user/message',
          {
            id: 'checkpoint',
            role: 'user',
            content: [{ type: 'text', text: 'summary checkpoint' }],
            source: { kind: 'context', producer: 'compaction' },
          },
          { surfaceOp: { op: 'replace', start: 0, end: 1 } },
        ),
        at(4, 'compaction/end', { compactionId: 'complete', turn: null }),
        at(5, 'compaction/start', { compactionId: 'orphan', turn: null }),
        at(6, 'session/end-seed', {}),
      ]),
    )

    expect(current.requests).toMatchObject([
      {
        purpose: 'compaction',
        startSeq: 1,
        status: 'complete',
        resultSeq: 2,
        replacementSeq: 3,
        summary: [{ type: 'text', text: 'summary' }],
        usage: { inputTokens: 20, outputTokens: 5 },
        requestConfig: {
          provider: 'test',
          model: 'test',
          maxTokens: 100,
          purpose: 'compaction',
        },
      },
      {
        purpose: 'compaction',
        startSeq: 5,
        status: 'error',
        completedAt: 1_700_000_000_006,
      },
    ])
    // The checkpoint replacement is not a separate input record.
    expect(current.eventNodes).toEqual([])
  })

  it('classifies claimed inbox input as steering and consumes one inherited prompt change', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'request/header', {
        reason: 'initial',
        header: {
          config: { provider: 'test', model: 'test' },
          system: 'system prompt',
          tools: [],
        },
      }),
      at(
        4,
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: assistantMessage('assistant-1', [
            { type: 'text', text: 'first' },
          ]),
        },
        APPEND,
      ),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        removedCount: 0,
        inserted: [
          {
            id: 'm1',
            role: 'user',
            content: [{ type: 'text', text: 'steer here' }],
            source: { kind: 'user' },
          },
        ],
      }),
      at(7, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        removedCount: 1,
        inserted: [],
      }),
      at(8, 'step/start', { turn: 1, step: 2 }),
    ])
    value.append(user(9, 'm1', 'steer here'))
    value.flush()

    const steering = snapshot(value)
    expect(steering.eventNodes.find((node) => node.seq === 9)?.kind).toBe(
      'steering',
    )
    expect(steering.eventLocations.get(9)).toEqual({
      kind: 'step',
      turn: 1,
      step: 2,
    })

    value.append(
      at(
        10,
        'assistant/message',
        {
          turn: 1,
          step: 2,
          message: assistantMessage('assistant-2', [
            { type: 'text', text: 'second' },
          ]),
        },
        APPEND,
      ),
    )
    value.flush()
    const current = snapshot(value)

    expect(
      current.requests.map((request) =>
        request.purpose === 'assistant' ? request.prompt?.system : undefined,
      ),
    ).toEqual(['system prompt', 'system prompt'])
    expect(
      current.requests.map((request) =>
        request.purpose === 'assistant'
          ? request.promptChange?.kind
          : undefined,
      ),
    ).toEqual(['initial', undefined])
    // Steering lands in its step, before the step's assistant record.
    const layout = deriveTrajectoryLayout({
      nodes: current.eventNodes,
      eventLocations: current.eventLocations,
      partial: current.partial,
      runningCalls: current.runningCalls,
      requests: current.requests,
    })
    expect(
      layout[0]?.groups.find((group) => group.title === 'Step 2')?.cells,
    ).toMatchObject([
      { kind: 'user', previewMarkdown: 'steer here' },
      { kind: 'message', previewMarkdown: 'second' },
    ])
  })
})

describe('Emperor-specific trajectory mapping', () => {
  it('shows the host display text on the user record', () => {
    const current = snapshot(
      assembler([
        at(1, 'host/user-meta', {
          messageId: 'u1',
          displayContent: 'look at @file',
          attachments: [{ id: 'a1', name: 'file.txt' }],
        }),
        at(2, 'turn/start', { turn: 1 }),
        at(3, 'step/start', { turn: 1, step: 1 }),
        user(4, 'u1', 'look at /abs/file.txt'),
      ]),
    )
    const node = current.eventNodes[0] as TrajectoryUserNode
    expect(node).toMatchObject({
      kind: 'user',
      displayText: 'look at @file',
      meta: { attachments: [{ id: 'a1', name: 'file.txt' }] },
    })
    const layout = deriveTrajectoryLayout({
      nodes: current.eventNodes,
      partial: null,
      runningCalls: [],
    })
    expect(layout[0]?.groups[0]?.cells[0]).toMatchObject({
      kind: 'user',
      previewMarkdown: 'look at @file',
      displayText: 'look at @file',
      inputDetail: 'look at /abs/file.txt',
      opensTurn: true,
    })
  })

  it('enriches the subagent tool record with its child session', () => {
    const current = snapshot(
      assembler([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        at(3, 'tool/call', {
          turn: 1,
          step: 1,
          callId: 'call-sub',
          name: 'subagent',
          arguments: '{"description":"research"}',
        }),
        at(4, 'subagent/started', {
          subagentId: 'sub-1',
          description: 'research',
          mode: 'spawn',
          callId: 'call-sub',
          background: false,
        }),
        at(5, 'subagent/settled', {
          subagentId: 'sub-1',
          stopReason: 'completed',
          text: 'done',
        }),
        toolResult(6, 'call-sub', 'done'),
      ]),
    )
    const tool = current.eventNodes[0] as TrajectoryToolResultNode
    expect(tool).toMatchObject({
      callId: 'call-sub',
      childSessionId: 'sub-1',
      subagent: {
        childSessionId: 'sub-1',
        status: 'settled',
        stopReason: 'completed',
        text: 'done',
      },
    })
    const cells = deriveTrajectoryLayout({
      nodes: current.eventNodes,
      partial: null,
      runningCalls: [],
    })[0]?.groups.flatMap((group) => group.cells)
    expect(cells?.[0]).toMatchObject({
      kind: 'tool',
      childSessionId: 'sub-1',
      subagent: { status: 'settled' },
    })
  })

  it('turns workflow members into subtools with their child sessions', () => {
    const current = snapshot(
      assembler([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        at(3, 'tool/call', {
          turn: 1,
          step: 1,
          callId: 'call-wf',
          name: 'workflow',
          arguments: '{}',
        }),
        at(4, 'tool-workflow/run-start', {
          runId: 'run-1',
          name: 'review',
          tool: 'workflow',
          callId: 'call-wf',
        }),
        at(5, 'tool-workflow/phase', { runId: 'run-1', title: 'scan' }),
        at(6, 'tool-workflow/agent-start', {
          runId: 'run-1',
          seq: 1,
          label: 'scanner',
          childId: 'child-1',
        }),
        at(7, 'tool-workflow/agent-end', {
          runId: 'run-1',
          seq: 1,
          outcome: 'completed',
        }),
        at(8, 'tool-workflow/run-end', {
          runId: 'run-1',
          stopReason: 'completed',
          result: 'ok',
        }),
        toolResult(9, 'call-wf', 'ok'),
      ]),
    )
    const tool = current.eventNodes[0] as TrajectoryToolResultNode
    expect(tool.workflow).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      phases: ['scan'],
    })
    expect(tool.subCalls).toMatchObject([
      {
        kind: 'tool-result',
        callId: 'workflow:run-1:1',
        call: {
          name: 'scanner',
          argsRaw: '{"childId":"child-1","phase":"scan"}',
        },
        childSessionId: 'child-1',
        isError: false,
      },
    ])
    const cells = deriveTrajectoryLayout({
      nodes: current.eventNodes,
      partial: null,
      runningCalls: [],
    })[0]?.groups.flatMap((group) => group.cells)
    expect(cells?.map((cell) => [cell.kind, cell.text])).toEqual([
      ['tool', 'workflow'],
      ['subtool', 'scanner'],
    ])
    expect(cells?.[1]?.childSessionId).toBe('child-1')
  })

  it('renders a workflow run without a calling tool as a standalone record', () => {
    const current = snapshot(
      assembler([
        at(1, 'tool-workflow/run-start', { runId: 'r2', name: 'nightly' }),
        at(2, 'tool-workflow/agent-start', {
          runId: 'r2',
          seq: 1,
          label: 'worker',
          childId: 'child-9',
        }),
      ]),
    )
    expect(current.runningCalls).toMatchObject([
      {
        callId: 'workflow:r2',
        name: 'workflow',
        workflow: { name: 'nightly', status: 'running' },
        subCalls: [{ callId: 'workflow:r2:1', childSessionId: 'child-9' }],
      },
    ])
  })

  it('records harness facts as located context records', () => {
    const current = snapshot(
      assembler([
        at(1, 'plan/mode', { active: true }),
        at(2, 'turn/start', { turn: 1 }),
        at(3, 'goal/change', {
          kind: 'goal/change',
          version: 1,
          operation: 'create',
          goal: {
            id: 'g1',
            revision: 1,
            objective: 'ship it',
            phase: 'active',
            maxGoalRounds: 3,
          },
          roundsStarted: 0,
          createdAt: 0,
          updatedAt: 0,
        }),
        at(4, 'instructions/baseline', { digest: 'd', files: ['AGENTS.md'] }),
        at(5, 'memory/baseline', { digest: '' }),
        at(6, 'step/start', { turn: 1, step: 1 }),
        user(7, 'u1', 'go'),
        at(
          8,
          'assistant/message',
          {
            turn: 1,
            step: 1,
            message: assistantMessage('a1', [
              { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
            ]),
          },
          APPEND,
        ),
        at(9, 'tool/call', {
          turn: 1,
          step: 1,
          callId: 'c1',
          name: 'bash',
          arguments: '{}',
        }),
        at(10, 'hook/invoked', {
          turn: 1,
          point: 'PreToolUse',
          dialect: 'claude-code',
          matcher: 'bash',
          handlerId: 'h1',
        }),
        at(11, 'hook/result', {
          turn: 1,
          point: 'PreToolUse',
          handlerId: 'h1',
          decision: 'pass',
          exitCode: 0,
          durationMs: 1500,
        }),
        at(12, 'approval/asked', {
          id: 'ap1',
          toolName: 'bash',
          callId: 'c1',
          reason: 'network',
        }),
        at(13, 'approval/decided', { id: 'ap1', outcome: 'rejected' }),
        toolResult(14, 'c1', 'denied'),
      ]),
    )
    expect(
      contexts(current).map((node) => [
        node.seq,
        node.eventType,
        node.label,
        node.content[0]?.type === 'text' ? node.content[0].text : '',
      ]),
    ).toEqual([
      [1, 'plan/mode', 'Plan mode', 'on'],
      [3, 'goal/change', 'Goal', 'create · active\nship it'],
      [4, 'instructions/baseline', 'Instructions', 'AGENTS.md'],
      [
        10,
        'hook/invoked',
        'Hook · PreToolUse',
        'claude-code · bash\ndecision: pass · exit 0',
      ],
      [12, 'approval/asked', 'Approval · bash', 'rejected\nnetwork'],
    ])
    const layout = deriveTrajectoryLayout({
      nodes: current.eventNodes,
      eventLocations: current.eventLocations,
      partial: null,
      runningCalls: [],
      requests: current.requests,
    })
    expect(
      layout[0]?.groups.map((group) => [
        group.title,
        group.cells.map((cell) => `${cell.kind}:${cell.text}`),
      ]),
    ).toEqual([
      [
        'Message',
        ['context:Plan mode', 'context:Goal', 'context:Instructions', 'user:'],
      ],
      [
        'Step 1',
        [
          'message:Tool call only',
          'tool:bash',
          'context:Hook · PreToolUse',
          'context:Approval · bash',
        ],
      ],
    ])
    const hook = layout[0]?.groups[1]?.cells[2]
    expect(hook).toMatchObject({ timeSeconds: 1.5, eventType: 'hook/invoked' })
    expect(layout[0]?.groups[1]?.cells[3]?.isError).toBe(true)
  })

  it('attaches fallback and cost-cap notices to the request and its record', () => {
    const current = snapshot(
      assembler([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        at(3, 'assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'lost' },
        }),
        at(4, 'llm/fallback', {
          fallbackId: 'f1',
          turn: 1,
          step: 1,
          from: 'primary',
          to: 'backup',
          trigger: 'error',
          failure: { code: 'SERVER', message: 'down' },
        }),
        at(
          5,
          'assistant/message',
          {
            turn: 1,
            step: 1,
            message: assistantMessage('a1', [{ type: 'text', text: 'kept' }]),
            usage: { inputTokens: 5, outputTokens: 5 },
          },
          APPEND,
        ),
        at(6, 'llm/cost-cap', {
          turn: 1,
          step: 1,
          capUsdNanos: 100,
          spentUsdNanos: 120,
        }),
        at(7, 'step/end', { turn: 1, step: 1 }),
      ]),
    )
    expect(current.requests[0]).toMatchObject({
      status: 'complete',
      notices: [
        { kind: 'fallback', from: 'primary', to: 'backup', message: 'down' },
        { kind: 'cost-cap', capUsdNanos: 100, spentUsdNanos: 120 },
      ],
    })
    expect(current.eventNodes[0]).toMatchObject({
      kind: 'assistant',
      blocks: [{ kind: 'text', text: 'kept' }],
    })
    const message = deriveTrajectoryLayout({
      nodes: current.eventNodes,
      partial: null,
      runningCalls: [],
      requests: current.requests,
    })[0]?.groups[0]?.cells[0]
    expect(message?.notices?.map((notice) => notice.kind)).toEqual([
      'fallback',
      'cost-cap',
    ])
  })

  it('classifies request header changes against the previous header', () => {
    const header = (
      seq: number,
      reason: string,
      system: string,
      tools: string[],
    ) =>
      at(seq, 'request/header', {
        reason,
        header: {
          config: { provider: 'p', model: 'm' },
          system,
          tools: tools.map((name) => ({
            name,
            description: '',
            parameters: {},
          })),
        },
      })
    const current = snapshot(
      assembler([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        header(3, 'initial', 'a', ['read']),
        at(4, 'step/end', { turn: 1, step: 1 }),
        at(5, 'step/start', { turn: 1, step: 2 }),
        header(6, 'change', 'b', ['read']),
        at(7, 'step/end', { turn: 1, step: 2 }),
        at(8, 'step/start', { turn: 1, step: 3 }),
        header(9, 'change', 'b', ['read', 'edit']),
        at(10, 'step/end', { turn: 1, step: 3 }),
        at(11, 'step/start', { turn: 1, step: 4 }),
        header(12, 'resume', 'b', ['read', 'edit']),
      ]),
    )
    expect(
      current.requests.map((request) =>
        request.purpose === 'assistant'
          ? [request.prompt?.system, request.promptChange?.kind]
          : undefined,
      ),
    ).toEqual([
      ['a', 'initial'],
      ['b', 'system'],
      ['b', 'tools'],
      ['b', undefined],
    ])
    // A window starting at a resumed header claims no initial prompt.
    const resumed = snapshot(
      assembler([
        at(20, 'turn/start', { turn: 2 }),
        at(21, 'step/start', { turn: 2, step: 1 }),
        header(22, 'resume', 'b', []),
      ]),
    )
    expect(resumed.requests[0]).toMatchObject({ prompt: { system: 'b' } })
    expect(
      resumed.requests[0]?.purpose === 'assistant'
        ? resumed.requests[0].promptChange
        : 'x',
    ).toBeUndefined()
  })
})
