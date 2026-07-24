import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ControlManager } from '../control/manager'
import { ProposePlanTool } from '../control/tools'
import { PlanStatus } from '../plans/models'
import { ToolResultObj, type ToolArtifact } from '../tools/base'
import { TodoStore } from '../tools/builtin'
import { redactSensitiveOutput } from '../util/redaction'
import {
  GoalEvidenceLedger,
  GoalObservationRecorder,
  computeGoalObservationOutputSha256,
  computeGoalToolInputSha256,
  verifyObservationIntegrity,
  type GoalEvidence,
  type GoalObservation,
} from './evidence'
import { GoalStore } from './store'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'

const T0 = '2026-07-15T10:00:00.000Z'
const T1 = '2026-07-15T10:01:00.000Z'
const T2 = '2026-07-15T10:02:00.000Z'
const T3 = '2026-07-15T10:03:00.000Z'
const T4 = '2026-07-15T10:04:00.000Z'

describe('Goal evidence trust chain', () => {
  let stateRoot: string
  let store: GoalStore
  let recorder: GoalObservationRecorder
  let ledger: GoalEvidenceLedger
  let observationIndex: number
  let evidenceIndex: number
  let receiptIndex: number

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'emperor-goal-evidence-'))
    store = new GoalStore(stateRoot, { now: () => T2 })
    observationIndex = 0
    evidenceIndex = 0
    receiptIndex = 0
    recorder = new GoalObservationRecorder(store, {
      now: () => T2,
      idFactory: () => `obs_${++observationIndex}`,
    })
    ledger = new GoalEvidenceLedger(store, {
      now: () => T2,
      evidenceIdFactory: () => `evidence_${++evidenceIndex}`,
      receiptIdFactory: () => `receipt_${++receiptIndex}`,
    })
  })

  it('records a real eligible final tool result with a reproducible output hash', async () => {
    const goal = await activeGoal('goal_hash', 'session-hash')
    const result = toolResult('final hook output', {
      artifacts: [managedImage('media_b'), managedImage('media_a')],
      rawContent: 'raw output must never be persisted',
    })

    const observation = await recorder.recordToolResult({
      sessionId: goal.scope.sessionId,
      turnId: 'turn_1',
      toolCallId: 'call_1',
      toolName: 'run_command',
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result,
    })

    expect(observation).toMatchObject({
      goalId: goal.id,
      turnId: 'turn_1',
      toolCallId: 'call_1',
      toolName: 'run_command',
      toolInput: {
        toolName: 'run_command',
        argumentsSha256: computeGoalToolInputSha256('run_command', {
          command: 'npm test',
        }).argumentsSha256,
        inputSha256: computeGoalToolInputSha256('run_command', {
          command: 'npm test',
        }).inputSha256,
      },
      evidencePolicy: 'eligible',
      eligible: true,
      isError: false,
      artifactRefs: ['media:media_a', 'media:media_b'],
      createdAt: T2,
    })
    expect(observation?.outputSha256).toBe(
      computeGoalObservationOutputSha256(result),
    )
    expect(verifyObservationIntegrity(observation!)).toBe(true)
    const persisted = await store.readObservations<GoalObservation>(goal.id)
    expect(persisted.records).toEqual([observation])
    expect(JSON.stringify(persisted.records)).not.toContain(result.rawContent)
    expect(JSON.stringify(persisted.records)).not.toContain('originalPath')
  })

  it('binds command evidence to the exact Core-computed tool arguments', async () => {
    const goal = await activeGoal(
      'goal_command_binding',
      'session-command-binding',
    )
    const cases = [
      ['different command', { command: 'echo ok' }],
      ['different argument', { command: 'npm test', timeout: 1 }],
      ['quoted whitespace', { command: 'npm test -- --grep "a  b"' }],
    ] as const

    for (const [label, args] of cases) {
      const observation = await recorder.recordToolResult({
        sessionId: goal.scope.sessionId,
        turnId: `turn_${label.replaceAll(' ', '_')}`,
        toolCallId: `call_${label.replaceAll(' ', '_')}`,
        toolName: 'run_command',
        arguments: args,
        evidencePolicy: 'eligible',
        executed: true,
        result: toolResult('ok'),
      })
      await expect(
        ledger.record(goal.id, {
          criterionId: 'AC-1',
          verdict: 'pass',
          check: 'npm test',
          summary: label,
          sourceObservationIds: [observation!.id],
          sourceReceiptIds: [],
        }),
      ).rejects.toMatchObject({
        code: 'goal_evidence_verification_incompatible',
      })
    }

    const exact = await recorder.recordToolResult({
      sessionId: goal.scope.sessionId,
      turnId: 'turn_exact_command',
      toolCallId: 'call_exact_command',
      toolName: 'run_command',
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result: toolResult('ok'),
    })
    await expect(recordEvidence(goal.id, exact!.id)).resolves.toMatchObject({
      verdict: 'pass',
    })
  })

  it('normalizes artifact order and ignores arbitrary or absolute paths', () => {
    const left = toolResult('same output', {
      artifacts: [
        unmanagedArtifact('/Users/private/forged.zip'),
        managedImage('media_z'),
        managedImage('media_a'),
      ],
    })
    const right = toolResult('same output', {
      artifacts: [managedImage('media_a'), managedImage('media_z')],
    })

    expect(computeGoalObservationOutputSha256(left)).toBe(
      computeGoalObservationOutputSha256(right),
    )
  })

  it('accepts explicit Task transcript refs only through a Core trust resolver', async () => {
    const goal = await activeGoal('goal_task_artifact', 'session-task-artifact')
    const forged = await recorder.recordToolResult({
      sessionId: goal.scope.sessionId,
      turnId: 'turn_forged_artifact',
      toolCallId: 'call_forged_artifact',
      toolName: 'dispatch_subagent',
      evidencePolicy: 'forbidden',
      executed: true,
      result: toolResult('subagent summary'),
      artifactRefs: [
        'media:model-invented',
        'task:task_trusted:transcript',
        '/private/forged-transcript.jsonl',
      ],
    })
    expect(forged?.artifactRefs).toEqual([])

    const trustedRecorder = new GoalObservationRecorder(store, {
      now: () => T2,
      idFactory: () => 'obs_trusted_task',
      isTrustedTaskTranscriptRef: (ref) =>
        ref === 'task:task_trusted:transcript',
    })
    const trusted = await trustedRecorder.recordToolResult({
      sessionId: goal.scope.sessionId,
      turnId: 'turn_trusted_artifact',
      toolCallId: 'call_trusted_artifact',
      toolName: 'dispatch_subagent',
      evidencePolicy: 'forbidden',
      executed: true,
      result: toolResult('subagent summary'),
      artifactRefs: ['task:task_trusted:transcript'],
    })
    expect(trusted?.artifactRefs).toEqual(['task:task_trusted:transcript'])
  })

  it('redacts and bounds the persisted summary without weakening the full output hash', async () => {
    const goal = await activeGoal('goal_redaction', 'session-redaction')
    const secret = [
      homedir(),
      'token=top-secret',
      'Authorization: Bearer bearer-secret',
      'Cookie: session=cookie-secret',
      'https://example.com/result?token=url-secret#private',
      'x'.repeat(900),
    ].join(' ')
    const result = toolResult(secret, { displaySummary: secret })

    const observation = await recorder.recordToolResult({
      sessionId: goal.scope.sessionId,
      turnId: 'turn_secret',
      toolCallId: 'call_secret',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      executed: true,
      result,
    })

    expect(observation?.displaySummary.length).toBeLessThanOrEqual(500)
    expect(observation?.displaySummary).toContain('[HOME]')
    expect(observation?.displaySummary).not.toMatch(
      /top-secret|bearer-secret|cookie-secret|url-secret/,
    )
    expect(observation?.outputSha256).toBe(
      computeGoalObservationOutputSha256(result),
    )
  })

  it('redacts path, JSON/colon credential, environment, URL, HOME, and user variants', () => {
    const redacted = redactSensitiveOutput(
      [
        '/private/tmp/secret.txt',
        'C:\\Users\\alice\\secret.txt',
        '{"apiKey":"json-secret"}',
        'password: colon-secret',
        'OPENAI_API_KEY=env-secret',
        'AWS_SECRET_ACCESS_KEY: aws-secret',
        'https://example.com/result?q=query-secret#hash-secret',
        '/Users/alice/project',
        'alice',
      ].join('\n'),
      { home: '/Users/alice', username: 'alice' },
    )

    expect(redacted).not.toMatch(
      /private|secret\.txt|json-secret|colon-secret|env-secret|aws-secret|query-secret|hash-secret|alice/,
    )
    expect(redacted).toContain('[HOME]')
    expect(redacted).toContain('[USER]')
    expect(redacted).toContain('https://example.com/result')
  })

  it('does not record denied, unexecuted, draft, terminal, or session-mismatched calls', async () => {
    const draft = await store.create(
      newGoalRecord({
        id: 'goal_draft',
        outcome: 'Draft outcome',
        scope: scope('session-draft'),
        now: T0,
      }),
    )
    const result = toolResult('permission denied', { isError: true })

    for (const input of [
      { sessionId: draft.scope.sessionId, executed: true },
      { sessionId: 'session-without-goal', executed: true },
      { sessionId: draft.scope.sessionId, executed: false },
    ]) {
      await expect(
        recorder.recordToolResult({
          ...input,
          turnId: 'turn_denied',
          toolCallId: `call_${input.sessionId}_${input.executed}`,
          toolName: 'run_command',
          evidencePolicy: 'eligible',
          result,
        }),
      ).resolves.toBeNull()
    }
    expect((await store.readObservations(draft.id)).records).toEqual([])
  })

  it('does not absorb a result into a replacement Goal created after tool start', async () => {
    const first = await activeGoal('goal_start_a', 'session-start-switch')
    const expectedGoalId = await recorder.captureExpectedGoalId(
      first.scope.sessionId,
    )
    const cancelled = assertGoalTransition(first, {
      ...first,
      status: 'cancelled',
      runtime: { ...first.runtime, phase: 'terminal' },
      terminalAt: T2,
      updatedAt: T2,
    })
    await store.append(first.id, {
      type: 'goal_updated',
      record: cancelled,
      createdAt: T2,
    })
    const replacement = await activeGoal('goal_start_b', first.scope.sessionId)

    await expect(
      recorder.recordToolResult({
        expectedGoalId,
        sessionId: first.scope.sessionId,
        turnId: 'turn_started_under_a',
        toolCallId: 'call_started_under_a',
        toolName: 'run_command',
        arguments: { command: 'npm test' },
        evidencePolicy: 'eligible',
        executed: true,
        result: toolResult('late result'),
      }),
    ).resolves.toBeNull()
    expect((await store.readObservations(replacement.id)).records).toEqual([])
  })

  it('does not absorb a result when no Goal existed at tool start', async () => {
    const expectedGoalId =
      await recorder.captureExpectedGoalId('session-start-none')
    const created = await activeGoal('goal_started_late', 'session-start-none')

    await expect(
      recorder.recordToolResult({
        expectedGoalId,
        sessionId: created.scope.sessionId,
        turnId: 'turn_started_without_goal',
        toolCallId: 'call_started_without_goal',
        toolName: 'run_command',
        arguments: { command: 'npm test' },
        evidencePolicy: 'eligible',
        executed: true,
        result: toolResult('late result'),
      }),
    ).resolves.toBeNull()
    expect((await store.readObservations(created.id)).records).toEqual([])
  })

  it('records context-only and forbidden executions but prevents them from becoming evidence', async () => {
    const goal = await activeGoal('goal_policy', 'session-policy')
    const context = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_context',
      toolName: 'new_unclassified_tool',
      evidencePolicy: 'context_only',
      result: toolResult('context'),
    })
    const forbidden = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_forbidden',
      toolName: 'update_todos',
      evidencePolicy: 'forbidden',
      result: toolResult('all todos complete'),
    })

    expect(context).toMatchObject({ eligible: false })
    expect(forbidden).toMatchObject({ eligible: false })
    for (const observation of [context, forbidden]) {
      await expect(
        ledger.record(goal.id, {
          criterionId: 'AC-1',
          verdict: 'pass',
          check: 'policy',
          summary: 'must not bind',
          sourceObservationIds: [observation!.id],
          sourceReceiptIds: [],
        }),
      ).rejects.toMatchObject({ code: 'goal_evidence_source_ineligible' })
    }
    expect(await ledger.listEvidence(goal.id)).toEqual([])
  })

  it('enforces toolUseId uniqueness under concurrent observation appends', async () => {
    const goal = await activeGoal(
      'goal_duplicate_call',
      'session-duplicate-call',
    )
    const input = {
      sessionId: goal.scope.sessionId,
      turnId: 'turn_parallel',
      toolCallId: 'call_same',
      toolName: 'run_command',
      evidencePolicy: 'eligible' as const,
      executed: true,
      result: toolResult('ok'),
    }

    const settled = await Promise.allSettled([
      recorder.recordToolResult(input),
      recorder.recordToolResult(input),
    ])

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    const rejected = settled.find((item) => item.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'goal_observation_tool_call_duplicate' },
    })
    expect(
      (await store.readObservations<GoalObservation>(goal.id)).records,
    ).toHaveLength(1)
  })

  it('records FAIL from a real error observation and later PASS without deleting history', async () => {
    const goal = await activeGoal('goal_latest', 'session-latest')
    const failed = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_fail',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('Error: tests failed', { isError: true }),
    })
    const passed = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_pass',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('tests passed'),
    })

    await expect(
      ledger.record(goal.id, {
        criterionId: 'AC-1',
        verdict: 'pass',
        check: 'npm test',
        summary: 'must not pass from a failed execution',
        sourceObservationIds: [failed!.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_source_failed' })
    await expect(
      ledger.record(goal.id, {
        criterionId: 'AC-1',
        verdict: 'fail',
        check: 'npm test',
        summary: 'must not fail from a successful execution',
        sourceObservationIds: [passed!.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_failure_source_required' })

    const failEvidence = await ledger.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'fail',
      check: 'npm test',
      summary: 'failed first',
      sourceObservationIds: [failed!.id],
      sourceReceiptIds: [],
    })
    const passEvidence = await ledger.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'npm test',
      summary: 'passed after repair',
      sourceObservationIds: [passed!.id],
      sourceReceiptIds: [],
    })

    expect(await ledger.listEvidence(goal.id)).toEqual([
      failEvidence,
      passEvidence,
    ])
    expect(await ledger.latestEvidenceForCriterion(goal.id, 'AC-1')).toEqual(
      passEvidence,
    )
    expect((await store.get(goal.id))?.latestEvidenceByCriterion).toEqual({
      'AC-1': passEvidence.id,
    })
  })

  it('enforces criterion kind and exact command binding for FAIL evidence', async () => {
    const goal = await activeGoal('goal_fail_kind', 'session-fail-kind')
    const readError = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_read_error',
      toolName: 'read_file',
      evidencePolicy: 'eligible',
      result: toolResult('read failed', { isError: true }),
    })
    const commandError = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_command_error',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('command failed', { isError: true }),
    })

    await expect(
      ledger.record(goal.id, {
        criterionId: 'AC-1',
        verdict: 'fail',
        check: 'read cannot fail command',
        summary: 'wrong kind',
        sourceObservationIds: [readError!.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_failure_source_required' })
    await expect(
      ledger.record(goal.id, {
        criterionId: 'AC-2',
        verdict: 'fail',
        check: 'command cannot fail manual',
        summary: 'wrong kind',
        sourceObservationIds: [commandError!.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_failure_source_required' })
  })

  it('requires matching trusted FAIL receipts for manual and reviewer criteria', async () => {
    const goal = await activeGoal('goal_fail_receipts', 'session-fail-receipts')
    const grounding = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_fail_grounding',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('grounded'),
    })
    const trusted = new GoalEvidenceLedger(store, {
      now: () => T3,
      evidenceIdFactory: () => `fail_evidence_${++evidenceIndex}`,
      receiptIdFactory: () => `fail_receipt_${++receiptIndex}`,
      factResolvers: {
        resolveUserManual(requestGoalId, source) {
          return {
            ...source,
            goalId: requestGoalId,
            summary: 'User reported manual failure.',
          }
        },
        resolveIndependentReviewer(requestGoalId, source) {
          return {
            ...source,
            goalId: requestGoalId,
            summary: 'Reviewer reported failure.',
          }
        },
      },
    })
    const manual = await trusted.issueUserManualReceipt(goal.id, {
      interactionId: 'answer_fail',
      criterionId: 'AC-2',
      verdict: 'fail',
    })
    const reviewer = await trusted.issueIndependentReviewerReceipt(goal.id, {
      taskId: 'review_fail',
      transcriptRef: 'task:review_fail:transcript',
      criterionId: 'AC-3',
      verdict: 'fail',
    })

    await expect(
      trusted.record(goal.id, {
        criterionId: 'AC-2',
        verdict: 'fail',
        check: 'manual fail',
        summary: 'manual fail',
        sourceObservationIds: [],
        sourceReceiptIds: [manual.id],
      }),
    ).resolves.toMatchObject({ verdict: 'fail', criterionId: 'AC-2' })
    await expect(
      trusted.record(goal.id, {
        criterionId: 'AC-3',
        verdict: 'fail',
        check: 'reviewer fail',
        summary: 'reviewer fail',
        sourceObservationIds: [grounding!.id],
        sourceReceiptIds: [reviewer.id],
      }),
    ).resolves.toMatchObject({ verdict: 'fail', criterionId: 'AC-3' })
  })

  it('canonicalizes multiple sources and rejects duplicate source IDs without mutating the ledger', async () => {
    const goal = await activeGoal('goal_sources', 'session-sources')
    const first = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_b',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('part b'),
    })
    const second = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_a',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('part a'),
    })
    const evidence = await ledger.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'combined',
      summary: 'two commands',
      sourceObservationIds: [first!.id, second!.id],
      sourceReceiptIds: [],
    })
    expect(evidence.sourceObservationIds).toEqual(
      [first!.id, second!.id].sort(),
    )

    await expect(
      ledger.record(goal.id, {
        criterionId: 'AC-1',
        verdict: 'pass',
        check: 'duplicate',
        summary: 'duplicate source',
        sourceObservationIds: [first!.id, first!.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_source_duplicate' })
    expect(await ledger.listEvidence(goal.id)).toEqual([evidence])
  })

  it('rejects a duplicate evidence ID before writing a second ledger event', async () => {
    const goal = await activeGoal(
      'goal_duplicate_evidence',
      'session-duplicate-evidence',
    )
    const first = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_duplicate_evidence_1',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('first'),
    })
    const second = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_duplicate_evidence_2',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('second'),
    })
    const duplicate = new GoalEvidenceLedger(store, {
      now: () => T3,
      evidenceIdFactory: () => 'evidence_duplicate',
    })
    await duplicate.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'first',
      summary: 'first',
      sourceObservationIds: [first!.id],
      sourceReceiptIds: [],
    })

    await expect(
      duplicate.record(goal.id, {
        criterionId: 'AC-1',
        verdict: 'pass',
        check: 'second',
        summary: 'second',
        sourceObservationIds: [second!.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_id_duplicate' })
    expect(await duplicate.listEvidence(goal.id)).toHaveLength(1)
  })

  it('merges different criteria from two Ledgers after a deterministic stale-read conflict', async () => {
    const goal = await activeGoal('goal_cas_criteria', 'session-cas-criteria')
    const command = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_cas_test',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('tests pass'),
    })
    const typecheck = await recorder.recordToolResult({
      sessionId: goal.scope.sessionId,
      turnId: 'turn_cas_typecheck',
      toolCallId: 'call_cas_typecheck',
      toolName: 'run_command',
      arguments: { command: 'npm run typecheck' },
      evidencePolicy: 'eligible',
      executed: true,
      result: toolResult('typecheck pass'),
    })
    const barrier = deferred<void>()
    const entered = deferred<void>()
    const stale = new GoalEvidenceLedger(store, {
      now: () => T2,
      evidenceIdFactory: () => 'evidence_cas_test',
      beforeAppendAttempt() {
        entered.resolve()
        return barrier.promise
      },
    })
    const concurrent = new GoalEvidenceLedger(store, {
      now: () => T3,
      evidenceIdFactory: () => 'evidence_cas_typecheck',
    })

    const first = stale.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'tests',
      summary: 'tests pass',
      sourceObservationIds: [command!.id],
      sourceReceiptIds: [],
    })
    await entered.promise
    await concurrent.record(goal.id, {
      criterionId: 'AC-5',
      verdict: 'pass',
      check: 'typecheck',
      summary: 'typecheck pass',
      sourceObservationIds: [typecheck!.id],
      sourceReceiptIds: [],
    })
    barrier.resolve()
    await first

    expect((await store.get(goal.id))?.latestEvidenceByCriterion).toMatchObject(
      {
        'AC-1': 'evidence_cas_test',
        'AC-5': 'evidence_cas_typecheck',
      },
    )
  })

  it('does not let an older PASS overwrite a newer FAIL or regress Goal phase', async () => {
    const goal = await activeGoal('goal_cas_newer', 'session-cas-newer')
    const passed = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_cas_old_pass',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('tests pass'),
    })
    const failed = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_cas_new_fail',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('tests fail', { isError: true }),
    })
    const barrier = deferred<void>()
    const entered = deferred<void>()
    const stale = new GoalEvidenceLedger(store, {
      now: () => T2,
      evidenceIdFactory: () => 'evidence_cas_old_pass',
      beforeAppendAttempt() {
        entered.resolve()
        return barrier.promise
      },
    })
    const newer = new GoalEvidenceLedger(store, {
      now: () => T4,
      evidenceIdFactory: () => 'evidence_cas_new_fail',
    })

    const oldPass = stale.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'old pass',
      summary: 'old pass',
      sourceObservationIds: [passed!.id],
      sourceReceiptIds: [],
    })
    await entered.promise
    let current = (await store.get(goal.id))!
    current = await store.append(goal.id, {
      type: 'goal_updated',
      createdAt: T3,
      record: {
        ...current,
        runtime: { ...current.runtime, phase: 'executing' },
        updatedAt: T3,
      },
    })
    await store.append(goal.id, {
      type: 'goal_updated',
      createdAt: T4,
      record: {
        ...current,
        runtime: { ...current.runtime, phase: 'verifying' },
        updatedAt: T4,
      },
    })
    const newFail = await newer.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'fail',
      check: 'new fail',
      summary: 'new fail',
      sourceObservationIds: [failed!.id],
      sourceReceiptIds: [],
    })
    barrier.resolve()
    await oldPass

    expect(await newer.latestEvidenceForCriterion(goal.id, 'AC-1')).toEqual(
      newFail,
    )
    expect((await store.get(goal.id))?.runtime.phase).toBe('verifying')
    expect(await newer.listEvidence(goal.id)).toHaveLength(2)
  })

  it('rejects unknown, cross-Goal, empty PASS, and criterion-kind-incompatible sources', async () => {
    const left = await activeGoal('goal_left', 'session-left')
    const right = await activeGoal('goal_right', 'session-right')
    const foreign = await record(right.id, right.scope.sessionId, {
      toolCallId: 'call_foreign',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('foreign'),
    })
    const read = await record(left.id, left.scope.sessionId, {
      toolCallId: 'call_read',
      toolName: 'read_file',
      evidencePolicy: 'eligible',
      result: toolResult('file contents'),
    })

    const cases: Array<
      [string, Partial<Parameters<GoalEvidenceLedger['record']>[1]>, string]
    > = [
      [
        'unknown',
        { sourceObservationIds: ['obs_unknown'] },
        'goal_evidence_source_unknown',
      ],
      [
        'cross goal',
        { sourceObservationIds: [foreign!.id] },
        'goal_evidence_source_cross_goal',
      ],
      [
        'empty pass',
        { sourceObservationIds: [] },
        'goal_evidence_pass_source_required',
      ],
      [
        'wrong kind',
        { sourceObservationIds: [read!.id] },
        'goal_evidence_verification_incompatible',
      ],
      [
        'unknown criterion',
        { criterionId: 'AC-404' },
        'goal_evidence_criterion_unknown',
      ],
    ]
    for (const [label, overrides, code] of cases) {
      await expect(
        ledger.record(left.id, {
          criterionId: 'AC-1',
          verdict: 'pass',
          check: label,
          summary: label,
          sourceObservationIds: [read!.id],
          sourceReceiptIds: [],
          ...overrides,
        }),
      ).rejects.toMatchObject({ code })
    }
    expect(await ledger.listEvidence(left.id)).toEqual([])
  })

  it('supports only trusted receipt combinations for manual and reviewer criteria', async () => {
    const goal = await activeGoal('goal_receipts', 'session-receipts')
    const observation = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_review_grounding',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('verified command'),
    })
    const trusted = trustedLedger(goal.id, observation!)
    const manual = await trusted.issueUserManualReceipt(goal.id, {
      interactionId: 'control_answer_1',
      criterionId: 'AC-2',
      verdict: 'pass',
    })
    const reviewer = await trusted.issueIndependentReviewerReceipt(goal.id, {
      taskId: 'review_task_1',
      transcriptRef: 'task:review_task_1:transcript',
      criterionId: 'AC-3',
      verdict: 'pass',
    })
    const plan = await trusted.issuePlanVerificationReceipt(goal.id, {
      planId: 'plan_1',
      stepId: 'step_1',
      requirementId: 'req_1',
      toolCallId: observation!.toolCallId,
      sourceObservationId: observation!.id,
      approvedInputHash: observation!.toolInput.inputSha256,
    })

    await expect(
      trusted.record(goal.id, {
        criterionId: 'AC-2',
        verdict: 'pass',
        check: 'manual',
        summary: 'confirmed',
        sourceObservationIds: [],
        sourceReceiptIds: [manual.id],
      }),
    ).resolves.toMatchObject({ criterionId: 'AC-2', verdict: 'pass' })
    await expect(
      trusted.record(goal.id, {
        criterionId: 'AC-3',
        verdict: 'pass',
        check: 'review',
        summary: 'reviewed with command grounding',
        sourceObservationIds: [observation!.id],
        sourceReceiptIds: [reviewer.id],
      }),
    ).resolves.toMatchObject({ criterionId: 'AC-3', independent: true })
    await expect(
      trusted.record(goal.id, {
        criterionId: 'AC-3',
        verdict: 'pass',
        check: 'review without grounding',
        summary: 'invalid',
        sourceObservationIds: [],
        sourceReceiptIds: [reviewer.id],
      }),
    ).rejects.toMatchObject({
      code: 'goal_evidence_reviewer_grounding_required',
    })
    await expect(
      trusted.record(goal.id, {
        criterionId: 'AC-2',
        verdict: 'pass',
        check: 'wrong receipt',
        summary: 'invalid',
        sourceObservationIds: [],
        sourceReceiptIds: [plan.id],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_verification_incompatible' })
  })

  it('fails closed when a typed receipt issuer has no Core fact resolver', async () => {
    const goal = await activeGoal(
      'goal_receipt_closed',
      'session-receipt-closed',
    )

    await expect(
      ledger.issueUserManualReceipt(goal.id, {
        interactionId: 'answer_missing',
        criterionId: 'AC-2',
        verdict: 'pass',
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_receipt_fact_untrusted' })
    await expect(
      ledger.issueIndependentReviewerReceipt(goal.id, {
        taskId: 'task_missing',
        transcriptRef: 'task:task_missing:transcript',
        criterionId: 'AC-3',
        verdict: 'pass',
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_receipt_fact_untrusted' })
  })

  it('invalidates a Plan receipt when its source observation is later corrupted', async () => {
    const goal = await activeGoal(
      'goal_receipt_source',
      'session-receipt-source',
    )
    const observation = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_receipt_source',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('passed'),
    })
    const trusted = trustedLedger(goal.id, observation!)
    const receipt = await trusted.issuePlanVerificationReceipt(goal.id, {
      planId: 'plan_source',
      stepId: 'step_source',
      requirementId: 'req_source',
      toolCallId: observation!.toolCallId,
      sourceObservationId: observation!.id,
      approvedInputHash: observation!.toolInput.inputSha256,
    })
    const evidence = await trusted.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'plan',
      summary: 'plan pass',
      sourceObservationIds: [],
      sourceReceiptIds: [receipt.id],
    })
    expect(await trusted.latestEvidenceForCriterion(goal.id, 'AC-1')).toEqual(
      evidence,
    )

    const path = join(stateRoot, 'goals', goal.id, 'observations.jsonl')
    const source = JSON.parse((await readFile(path, 'utf8')).trim())
    await writeFile(
      path,
      `${JSON.stringify({ ...source, outputSha256: '0'.repeat(64) })}\n`,
      'utf8',
    )
    expect(await trusted.latestEvidenceForCriterion(goal.id, 'AC-1')).toBeNull()
  })

  it('keeps structured colon IDs distinct and rejects newline IDs without writing', async () => {
    const goal = await activeGoal('goal_receipt_ids', 'session-receipt-ids')
    const observation = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_receipt_ids',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('passed'),
    })
    const receipts = new GoalEvidenceLedger(store, {
      now: () => T3,
      receiptIdFactory: () => `structured_receipt_${++receiptIndex}`,
      factResolvers: {
        resolvePlanVerification(goalId, source) {
          return { ...source, goalId, passed: true, summary: 'Plan passed.' }
        },
      },
    })
    const common = {
      requirementId: 'req:one',
      toolCallId: observation!.toolCallId,
      sourceObservationId: observation!.id,
      approvedInputHash: observation!.toolInput.inputSha256,
    }
    const first = await receipts.issuePlanVerificationReceipt(goal.id, {
      ...common,
      planId: 'plan:a',
      stepId: 'b',
    })
    const second = await receipts.issuePlanVerificationReceipt(goal.id, {
      ...common,
      planId: 'plan',
      stepId: 'a:b',
    })

    expect(first.source).not.toEqual(second.source)
    expect(await receipts.listReceipts(goal.id)).toHaveLength(2)
    await expect(
      receipts.issuePlanVerificationReceipt(goal.id, {
        ...common,
        planId: 'plan\nforged',
        stepId: 'step',
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_input_invalid' })
    expect(await receipts.listReceipts(goal.id)).toHaveLength(2)
  })

  it('invalidates latest evidence when the Core Plan fact is withdrawn', async () => {
    const goal = await activeGoal(
      'goal_plan_withdrawn',
      'session-plan-withdrawn',
    )
    const observation = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_plan_withdrawn',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('passed'),
    })
    let trusted = true
    const receipts = new GoalEvidenceLedger(store, {
      now: () => T3,
      evidenceIdFactory: () => 'evidence_plan_withdrawn',
      receiptIdFactory: () => 'receipt_plan_withdrawn',
      factResolvers: {
        resolvePlanVerification(goalId, source) {
          return trusted
            ? { ...source, goalId, passed: true, summary: 'Plan passed.' }
            : null
        },
      },
    })
    const receipt = await receipts.issuePlanVerificationReceipt(goal.id, {
      planId: 'plan_withdrawn',
      stepId: 'step_withdrawn',
      requirementId: 'req_withdrawn',
      toolCallId: observation!.toolCallId,
      sourceObservationId: observation!.id,
      approvedInputHash: observation!.toolInput.inputSha256,
    })
    const evidence = await receipts.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'plan',
      summary: 'plan pass',
      sourceObservationIds: [],
      sourceReceiptIds: [receipt.id],
    })
    expect(await receipts.latestEvidenceForCriterion(goal.id, 'AC-1')).toEqual(
      evidence,
    )

    trusted = false
    expect(
      await receipts.latestEvidenceForCriterion(goal.id, 'AC-1'),
    ).toBeNull()
    expect(await receipts.listReceipts(goal.id)).toEqual([receipt])
  })

  it('revalidates the real scoped Plan lifecycle and invalidates latest evidence after replacement', async () => {
    const goal = await activeGoal(
      'goal_plan_lifecycle',
      'session-plan-lifecycle',
    )
    const manager = new ControlManager(stateRoot)
    manager.setRuntimeScope({
      sessionId: goal.scope.sessionId,
      mode: goal.scope.mode,
      projectId: goal.scope.projectId,
      workspaceRoot: goal.scope.workspaceRoot,
      projectFingerprint: goal.scope.projectFingerprint,
    })
    manager.setActiveGoalPlanContext(goal)
    manager.setTodoStore(new TodoStore())
    const approvePlan = (title: string, command: string): string => {
      manager.setMode('plan')
      const draft = manager.recordPlanDiscovery({
        source: 'read_file',
        summary: 'Inspected the Goal verification implementation.',
        files: ['packages/core/src/goals/evidence.ts'],
        evidenceRefs: ['path:packages/core/src/goals/evidence.ts'],
      })
      const discoveryId = String(draft?.draft.discoveries.at(-1)?.id ?? '')
      if (!discoveryId) throw new Error('test discovery was not recorded')
      new ProposePlanTool(manager).execute({
        title,
        summary: `${title} summary`,
        plan_markdown: `# ${title}`,
        steps: [
          {
            id: 'step_1',
            title: 'Verify',
            description: 'Run verification.',
            files: [],
            commands: [command],
            acceptance: ['command passes'],
            discovery_refs: [discoveryId],
          },
        ],
        assumptions: [],
        risk_level: 'low',
      })
      const pending = manager.payload().pending as Record<string, unknown>
      manager.approve(String(pending.id))
      return manager.planStore.latest()!.id
    }
    const planId = approvePlan('Current Plan', 'npm test')
    await store.append(goal.id, {
      type: 'goal_updated',
      record: {
        ...goal,
        runtime: {
          ...goal.runtime,
          phase: 'executing',
          currentPlanId: planId,
        },
        updatedAt: T2,
      },
      createdAt: T2,
      expectedLastEventSeq: goal.lastEventSeq,
    })
    const target = manager.planVerificationTarget('npm test')!
    const observation = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call-real-plan-lifecycle',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('tests passed'),
    })
    manager.recordPlanVerificationResult({
      planId,
      stepId: target.step_id!,
      result: {
        requirement_id: target.requirement_id,
        tool_call_id: observation!.toolCallId,
        command: 'npm test',
        passed: true,
        exit_code: 0,
        summary: 'tests passed',
      },
    })
    const lifecycleLedger = new GoalEvidenceLedger(store, {
      factResolvers: {
        async resolvePlanVerification(goalId, source) {
          const currentGoal = await store.get(goalId)
          return currentGoal === null
            ? null
            : manager.resolveGoalPlanVerificationFact(
                goalId,
                currentGoal,
                source,
              )
        },
      },
    })
    const receipt = await lifecycleLedger.issuePlanVerificationReceipt(
      goal.id,
      {
        planId,
        stepId: target.step_id!,
        requirementId: target.requirement_id!,
        toolCallId: observation!.toolCallId,
        sourceObservationId: observation!.id,
        approvedInputHash: observation!.toolInput.inputSha256,
      },
    )
    const evidence = await lifecycleLedger.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'npm test',
      summary: 'tests pass',
      sourceObservationIds: [],
      sourceReceiptIds: [receipt.id],
    })
    expect(
      await lifecycleLedger.latestEvidenceForCriterion(goal.id, 'AC-1'),
    ).toEqual(evidence)

    const completed = manager.planStore.get(planId)!
    manager.planStore.save({
      ...completed,
      status: PlanStatus.COMPLETED,
      completedAt: completed.updatedAt,
    })
    const replacementId = approvePlan('Replacement Plan', 'npm run typecheck')

    expect(manager.planStore.get(planId)).toMatchObject({
      status: PlanStatus.COMPLETED,
    })
    expect(
      await lifecycleLedger.latestEvidenceForCriterion(goal.id, 'AC-1'),
    ).toBeNull()

    const replacement = manager.planStore.get(replacementId)!
    manager.planStore.save({
      ...replacement,
      status: PlanStatus.CANCELLED,
      metadata: { ...replacement.metadata, cancelled_by: 'user' },
    })

    expect(
      await lifecycleLedger.latestEvidenceForCriterion(goal.id, 'AC-1'),
    ).toBeNull()
  })

  it('CAS-merges a stale typed receipt without overwriting newer FAIL or phase', async () => {
    const goal = await activeGoal('goal_receipt_cas', 'session-receipt-cas')
    const passed = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_receipt_cas_pass',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('passed'),
    })
    const failed = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_receipt_cas_fail',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('failed', { isError: true }),
    })
    await ledger.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'old pass',
      summary: 'old pass',
      sourceObservationIds: [passed!.id],
      sourceReceiptIds: [],
    })
    const barrier = deferred<void>()
    const entered = deferred<void>()
    const stale = new GoalEvidenceLedger(store, {
      now: () => '2026-07-15T10:05:00.000Z',
      receiptIdFactory: () => 'receipt_cas_stale',
      factResolvers: {
        resolveUserManual(requestGoalId, source) {
          return {
            ...source,
            goalId: requestGoalId,
            summary: 'User confirmed old state.',
          }
        },
      },
      beforeReceiptAppendAttempt() {
        entered.resolve()
        return barrier.promise
      },
    })
    const receiptPromise = stale.issueUserManualReceipt(goal.id, {
      interactionId: 'answer_receipt_cas',
      criterionId: 'AC-2',
      verdict: 'pass',
    })
    await Promise.race([
      entered.promise,
      receiptPromise.then(() => {
        throw new Error('receipt append barrier was not reached')
      }),
    ])

    let current = (await store.get(goal.id))!
    current = await store.append(goal.id, {
      type: 'goal_updated',
      createdAt: T3,
      record: {
        ...current,
        runtime: { ...current.runtime, phase: 'executing' },
        updatedAt: T3,
      },
    })
    await store.append(goal.id, {
      type: 'goal_updated',
      createdAt: T4,
      record: {
        ...current,
        runtime: { ...current.runtime, phase: 'verifying' },
        updatedAt: T4,
      },
    })
    const newer = new GoalEvidenceLedger(store, {
      now: () => T4,
      evidenceIdFactory: () => 'evidence_receipt_cas_fail',
    })
    const newFail = await newer.record(goal.id, {
      criterionId: 'AC-1',
      verdict: 'fail',
      check: 'new fail',
      summary: 'new fail',
      sourceObservationIds: [failed!.id],
      sourceReceiptIds: [],
    })
    barrier.resolve()
    const receipt = await receiptPromise

    expect(await newer.latestEvidenceForCriterion(goal.id, 'AC-1')).toEqual(
      newFail,
    )
    expect((await store.get(goal.id))?.runtime.phase).toBe('verifying')
    expect(await stale.listReceipts(goal.id)).toEqual([receipt])
  })

  it('CAS-retries two independent typed issuers without dropping either receipt', async () => {
    const goal = await activeGoal(
      'goal_receipt_cas_two',
      'session-receipt-cas-two',
    )
    const barrier = deferred<void>()
    const entered = deferred<void>()
    const resolvers = {
      resolveUserManual(requestGoalId: string, source: any) {
        return { ...source, goalId: requestGoalId, summary: 'User fact.' }
      },
      resolveIndependentReviewer(requestGoalId: string, source: any) {
        return { ...source, goalId: requestGoalId, summary: 'Reviewer fact.' }
      },
    }
    const firstLedger = new GoalEvidenceLedger(store, {
      now: () => T3,
      receiptIdFactory: () => 'receipt_cas_first',
      factResolvers: resolvers,
      beforeReceiptAppendAttempt() {
        entered.resolve()
        return barrier.promise
      },
    })
    const secondLedger = new GoalEvidenceLedger(store, {
      now: () => T4,
      receiptIdFactory: () => 'receipt_cas_second',
      factResolvers: resolvers,
    })
    const firstPromise = firstLedger.issueUserManualReceipt(goal.id, {
      interactionId: 'answer_cas_first',
      criterionId: 'AC-2',
      verdict: 'pass',
    })
    await Promise.race([
      entered.promise,
      firstPromise.then(() => {
        throw new Error('receipt append barrier was not reached')
      }),
    ])
    const second = await secondLedger.issueIndependentReviewerReceipt(goal.id, {
      taskId: 'review_cas_second',
      transcriptRef: 'task:review_cas_second:transcript',
      criterionId: 'AC-3',
      verdict: 'pass',
    })
    barrier.resolve()
    const first = await firstPromise

    expect(await firstLedger.listReceipts(goal.id)).toEqual(
      expect.arrayContaining([first, second]),
    )
    expect(await firstLedger.listReceipts(goal.id)).toHaveLength(2)
  })

  it('fails closed for tampered, duplicate, malformed, or missing observation facts', async () => {
    const goal = await activeGoal('goal_corrupt', 'session-corrupt')
    const observation = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_corrupt',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('trusted result'),
    })
    const observationsPath = join(
      stateRoot,
      'goals',
      goal.id,
      'observations.jsonl',
    )
    const original = await readFile(observationsPath, 'utf8')
    const tampered = {
      ...JSON.parse(original.trim()),
      outputSha256: '0'.repeat(64),
    }
    await writeFile(observationsPath, `${JSON.stringify(tampered)}\n`, 'utf8')
    await expect(
      recordEvidence(goal.id, observation!.id),
    ).rejects.toMatchObject({
      code: 'goal_observation_integrity_invalid',
    })

    await writeFile(observationsPath, original + original, 'utf8')
    await expect(
      recordEvidence(goal.id, observation!.id),
    ).rejects.toMatchObject({
      code: 'goal_observation_id_duplicate',
    })

    await writeFile(observationsPath, original, 'utf8')
    await appendFile(observationsPath, '{bad json\n', 'utf8')
    await expect(
      recordEvidence(goal.id, observation!.id),
    ).rejects.toMatchObject({
      code: 'goal_observation_store_corrupt',
    })

    await writeFile(observationsPath, '', 'utf8')
    await expect(
      recordEvidence(goal.id, observation!.id),
    ).rejects.toMatchObject({
      code: 'goal_evidence_source_unknown',
    })
    expect(await ledger.listEvidence(goal.id)).toEqual([])
  })

  it('invalidates the latest projection after source corruption while preserving evidence history', async () => {
    const goal = await activeGoal('goal_projection', 'session-projection')
    const observation = await record(goal.id, goal.scope.sessionId, {
      toolCallId: 'call_projection',
      toolName: 'run_command',
      evidencePolicy: 'eligible',
      result: toolResult('passed'),
    })
    const evidence = await recordEvidence(goal.id, observation!.id)
    expect(await ledger.latestEvidenceForCriterion(goal.id, 'AC-1')).toEqual(
      evidence,
    )

    const path = join(stateRoot, 'goals', goal.id, 'observations.jsonl')
    const source = JSON.parse((await readFile(path, 'utf8')).trim())
    await writeFile(
      path,
      `${JSON.stringify({ ...source, displaySummary: 'tampered' })}\n`,
      'utf8',
    )

    const restarted = new GoalEvidenceLedger(new GoalStore(stateRoot))
    expect(
      await restarted.latestEvidenceForCriterion(goal.id, 'AC-1'),
    ).toBeNull()
    expect(await restarted.listEvidence(goal.id)).toEqual([evidence])
  })

  async function activeGoal(id: string, sessionId: string) {
    const created = await store.create(
      newGoalRecord({
        id,
        outcome: `Outcome for ${id}`,
        scope: scope(sessionId),
        now: T0,
      }),
    )
    const locked = GoalContractValidator.lock(
      created,
      {
        inScope: ['core'],
        outOfScope: [],
        constraints: ['Use real evidence'],
        acceptanceCriteria: [
          criterion('AC-1', 'command'),
          criterion('AC-2', 'manual'),
          criterion('AC-3', 'reviewer'),
          criterion('AC-4', 'artifact'),
          {
            id: 'AC-5',
            description: 'typecheck criterion',
            required: true,
            verification: {
              kind: 'command',
              requirement: 'npm run typecheck',
            },
          },
        ],
        escalationConditions: [],
      },
      T1,
    )
    return await store.append(id, {
      type: 'goal_updated',
      record: locked,
      createdAt: T1,
    })
  }

  async function record(
    _goalId: string,
    sessionId: string,
    input: {
      toolCallId: string
      toolName: string
      evidencePolicy: 'eligible' | 'context_only' | 'forbidden'
      result: ToolResultObj
    },
  ) {
    return await recorder.recordToolResult({
      sessionId,
      turnId: 'turn_record',
      executed: true,
      arguments:
        input.toolName === 'run_command' ? { command: 'npm test' } : {},
      ...input,
    })
  }

  async function recordEvidence(
    goalId: string,
    observationId: string,
  ): Promise<GoalEvidence> {
    return await ledger.record(goalId, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'npm test',
      summary: 'tests pass',
      sourceObservationIds: [observationId],
      sourceReceiptIds: [],
    })
  }

  function trustedLedger(goalId: string, observation: GoalObservation) {
    return new GoalEvidenceLedger(store, {
      now: () => T2,
      evidenceIdFactory: () => `trusted_evidence_${++evidenceIndex}`,
      receiptIdFactory: () => `trusted_receipt_${++receiptIndex}`,
      factResolvers: {
        async resolveUserManual(requestGoalId, source) {
          if (
            requestGoalId !== goalId ||
            source.interactionId !== 'control_answer_1'
          )
            return null
          return {
            ...source,
            goalId: requestGoalId,
            verdict: 'pass',
            summary: 'User explicitly confirmed the manual check.',
          }
        },
        async resolveIndependentReviewer(requestGoalId, source) {
          if (requestGoalId !== goalId || source.taskId !== 'review_task_1')
            return null
          return {
            ...source,
            goalId: requestGoalId,
            verdict: 'pass',
            summary: 'Independent reviewer passed.',
          }
        },
        async resolvePlanVerification(requestGoalId, source) {
          if (
            requestGoalId !== goalId ||
            source.sourceObservationId !== observation.id
          )
            return null
          return {
            ...source,
            goalId: requestGoalId,
            passed: true,
            summary: 'Plan command passed.',
          }
        },
      },
    })
  }
})

function scope(sessionId: string) {
  return {
    sessionId,
    mode: 'build' as const,
    projectId: 'project-1',
    workspaceRoot: '/workspace/project',
  }
}

function criterion(
  id: string,
  kind: 'command' | 'artifact' | 'manual' | 'reviewer',
) {
  return {
    id,
    description: `${kind} criterion`,
    required: true,
    verification: {
      kind,
      requirement: kind === 'command' ? 'npm test' : `verify by ${kind}`,
    },
  }
}

function toolResult(
  modelContent: string,
  opts: {
    displaySummary?: string
    rawContent?: string
    artifacts?: ToolArtifact[]
    isError?: boolean
  } = {},
): ToolResultObj {
  return new ToolResultObj({
    modelContent,
    displaySummary: opts.displaySummary ?? modelContent,
    rawContent: opts.rawContent ?? modelContent,
    artifacts: opts.artifacts ?? [],
    isError: opts.isError ?? false,
  })
}

function managedImage(id: string): ToolArtifact {
  return {
    path: `/Users/private/${id}.png`,
    kind: 'media',
    bytes: 12,
    media: {
      id,
      kind: 'image',
      mime: 'image/png',
      name: `${id}.png`,
      relPath: `media/${id}.png`,
      originalPath: `/Users/private/${id}.png`,
    },
    metadata: { originalPath: `/Users/private/${id}.png` },
  }
}

function unmanagedArtifact(path: string): ToolArtifact {
  return {
    path,
    kind: 'file',
    bytes: 99,
    metadata: { path, rendererProvidedHash: 'forged' },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
