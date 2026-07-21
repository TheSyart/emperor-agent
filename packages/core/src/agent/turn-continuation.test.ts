import { describe, expect, it, vi } from 'vitest'
import {
  ModelTurnContinuationEvaluator,
  TurnProgressLedger,
  type TurnContinuationInput,
} from './turn-continuation'
import { ToolResultObj } from '../tools/base'

const input: TurnContinuationInput = {
  taskIntent: 'finish the approved implementation plan',
  plan: {
    id: 'plan_1',
    title: 'Implement feature',
    status: 'executing',
    steps: [
      {
        id: 'step_1',
        title: 'Implement feature',
        status: 'active',
        verificationStatus: 'pending',
      },
    ],
  },
  todos: [
    {
      id: 'plan:step_1',
      content: 'Implement feature',
      status: 'in_progress',
      planStepId: 'step_1',
    },
  ],
  successfulChanges: ['edit_file:index.html'],
  successfulEvidence: ['read_file:index.html:sha256'],
  recentErrors: ['PLAN_TODO_BINDING_REJECTED'],
  repeatedReadCount: 3,
  noProgressIterations: 1,
  lastIterationHadError: false,
  totalIterations: 20,
  evaluationRound: 1,
  lastAssistantProgress: 'Implemented the capability cards.',
}

function evaluator(content: string | null, timeoutMs = 8_000) {
  const chat = vi.fn(async (_request: unknown) => ({
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input: 10, output: 4 },
    reasoningContent: null,
    thinkingBlocks: null,
  }))
  const route = vi.fn(() => ({
    snapshot: {
      provider: { chat },
      providerName: 'openai',
      model: 'active-model',
      modelEntryId: 'active-entry',
    },
  }))
  const tokenTracker = { record: vi.fn() }
  const diagnosticSink = vi.fn()
  return {
    chat,
    route,
    tokenTracker,
    diagnosticSink,
    subject: new ModelTurnContinuationEvaluator({ route } as never, {
      timeoutMs,
      tokenTracker,
      diagnosticSink,
    }),
  }
}

describe('ModelTurnContinuationEvaluator', () => {
  it.each([4, 8, 12])(
    'accepts a strict continue decision requesting %i iterations',
    async (requestedIterations) => {
      const fixture = evaluator(
        JSON.stringify({
          decision: 'continue',
          reasonCode: 'verification_remaining',
          requestedIterations,
          nextActions: ['Run the required verification'],
          summary: 'Implementation exists and verification remains.',
        }),
      )

      await expect(fixture.subject.evaluate(input)).resolves.toEqual({
        decision: 'continue',
        reasonCode: 'verification_remaining',
        requestedIterations,
        nextActions: ['Run the required verification'],
        summary: 'Implementation exists and verification remains.',
      })
      expect(fixture.route).toHaveBeenCalledWith(
        'turn_continuation_evaluator',
        null,
        input.taskIntent,
      )
      expect(fixture.tokenTracker.record).toHaveBeenCalledWith(
        'active-model',
        { input: 10, output: 4 },
        expect.objectContaining({
          provider: 'openai',
          usageType: 'turn_continuation_evaluator',
          modelEntryId: 'active-entry',
          routeReason: 'turn_continuation_evaluator',
        }),
      )
      expect(fixture.diagnosticSink).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 1,
          status: 'response',
          rawOutput: expect.stringContaining('"decision":"continue"'),
        }),
      )
    },
  )

  it('caps an oversized evaluator request at twelve iterations', async () => {
    const fixture = evaluator(
      JSON.stringify({
        decision: 'continue',
        reasonCode: 'work_remaining',
        requestedIterations: 99,
        nextActions: ['Continue the bounded work'],
        summary: 'More work remains.',
      }),
    )

    await expect(fixture.subject.evaluate(input)).resolves.toMatchObject({
      decision: 'continue',
      requestedIterations: 12,
    })
  })

  it('uses a bounded tool-free deterministic request and redacts sensitive input', async () => {
    const fixture = evaluator(
      JSON.stringify({
        decision: 'pause',
        reasonCode: 'blocked',
        requestedIterations: 4,
        nextActions: ['Resolve the blocker'],
        summary: 'Blocked.',
      }),
    )

    await fixture.subject.evaluate({
      ...input,
      taskIntent: 'use token sk-secret-value in /Users/alice/private',
      recentErrors: ['command failed with password=hunter2'],
    })

    expect(fixture.chat).toHaveBeenCalledTimes(1)
    const request = fixture.chat.mock.calls[0]![0] as Record<string, unknown>
    expect(request).toMatchObject({
      tools: null,
      temperature: 0,
      maxTokens: 256,
      reasoningEffort: null,
    })
    const serialized = JSON.stringify(request)
    expect(serialized).not.toContain('sk-secret-value')
    expect(serialized).not.toContain('/Users/alice')
    expect(serialized).not.toContain('hunter2')
    const messages = request.messages as Array<Record<string, unknown>>
    expect(() => JSON.parse(String(messages[1]?.content))).not.toThrow()
  })

  it('keeps oversized evaluator input as bounded valid JSON', async () => {
    const fixture = evaluator(
      JSON.stringify({
        decision: 'continue',
        reasonCode: 'work_remaining',
        requestedIterations: 4,
        nextActions: ['Continue'],
        summary: 'Work remains.',
      }),
    )
    await fixture.subject.evaluate({
      ...input,
      plan: {
        ...input.plan!,
        id: 'p'.repeat(20_000),
        title: 't'.repeat(20_000),
        steps: Array.from({ length: 100 }, (_, index) => ({
          id: `step_${index}_${'i'.repeat(1_000)}`,
          title: 's'.repeat(1_000),
          status: 'active'.repeat(1_000),
          verificationStatus: 'pending'.repeat(1_000),
        })),
      },
      todos: Array.from({ length: 100 }, (_, index) => ({
        id: `todo_${index}_${'i'.repeat(1_000)}`,
        content: 'x'.repeat(1_000),
        status: 'pending'.repeat(1_000),
        planStepId: 's'.repeat(1_000),
      })),
      successfulChanges: Array.from({ length: 100 }, () => 'x'.repeat(500)),
      successfulEvidence: Array.from({ length: 100 }, () => 'y'.repeat(500)),
    })
    const request = fixture.chat.mock.calls[0]![0] as Record<string, unknown>
    const messages = request.messages as Array<Record<string, unknown>>
    const content = String(messages[1]?.content)
    expect(content.length).toBeLessThanOrEqual(8_000)
    expect(() => JSON.parse(content)).not.toThrow()
  })

  it.each([
    ['string iteration count', '4', ['Continue'], 'More work.'],
    ['numeric action', 4, [123], 'More work.'],
    ['object summary', 4, ['Continue'], { text: 'More work.' }],
  ])('rejects %s without coercion', async (_label, iterations, actions, summary) => {
    const fixture = evaluator(
      JSON.stringify({
        decision: 'continue',
        reasonCode: 'work_remaining',
        requestedIterations: iterations,
        nextActions: actions,
        summary,
      }),
    )
    await expect(fixture.subject.evaluate(input)).resolves.toMatchObject({
      decision: 'pause',
      reasonCode: 'evaluation_failed',
    })
  })

  it('redacts malformed diagnostic output before persistence', async () => {
    const fixture = evaluator(
      'not-json ghp_123456789012345678901234567890 xoxb-1234567890-secret',
    )
    await fixture.subject.evaluate(input)
    const diagnostic = fixture.diagnosticSink.mock.calls[0]![0] as Record<
      string,
      unknown
    >
    expect(diagnostic.rawOutput).not.toContain('ghp_')
    expect(diagnostic.rawOutput).not.toContain('xoxb-')
    expect(diagnostic.rawOutputHash).toBeTruthy()
  })

  it.each([
    null,
    '',
    'not-json',
    '{"decision":"continue"}',
    JSON.stringify({
      decision: 'continue',
      reasonCode: 'work_remaining',
      requestedIterations: 4,
      nextActions: [],
      summary: 'More work.',
    }),
    JSON.stringify({
      decision: 'pause',
      reasonCode: 'blocked',
      requestedIterations: 4,
      nextActions: [],
      summary: 'Blocked.',
    }),
  ])('fails closed for invalid response %j', async (content) => {
    const fixture = evaluator(content)

    await expect(fixture.subject.evaluate(input)).resolves.toMatchObject({
      decision: 'pause',
      reasonCode: 'evaluation_failed',
      requestedIterations: 0,
      nextActions: [],
    })
  })

  it('times out without retrying', async () => {
    const chat = vi.fn(() => new Promise(() => undefined))
    const route = vi.fn(() => ({
      snapshot: {
        provider: { chat },
        providerName: 'openai',
        model: 'active-model',
        modelEntryId: 'active-entry',
      },
    }))
    const subject = new ModelTurnContinuationEvaluator({ route } as never, {
      timeoutMs: 5,
    })

    await expect(subject.evaluate(input)).resolves.toMatchObject({
      decision: 'pause',
      reasonCode: 'evaluation_failed',
    })
    expect(chat).toHaveBeenCalledTimes(1)
  })
})

describe('TurnProgressLedger', () => {
  it('does not count an identical mutation and result as new progress', () => {
    const ledger = new TurnProgressLedger()
    const call = {
      id: 'edit_1',
      name: 'edit_file',
      arguments: { path: 'index.html', old: 'a', replacement: 'b' },
    }
    const result = ToolResultObj.fromText('updated index.html')

    ledger.recordToolResult(call, result, { executed: true, readOnly: false })
    ledger.finishIteration()
    ledger.recordToolResult({ ...call, id: 'edit_2' }, result, {
      executed: true,
      readOnly: false,
    })
    ledger.finishIteration()

    expect(ledger.snapshot()).toMatchObject({
      meaningfulProgress: 1,
      noProgressIterations: 1,
      lastIterationHadError: false,
      successfulChanges: ['edit_file:index.html'],
    })
  })
})
