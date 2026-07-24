import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ActiveTaskRegistry,
  CancelledTaskError,
  activeTaskToDict,
} from './active'
import * as runtimeEvents from './events'
import {
  modelVisibleEnvelopePayloads,
  newRuntimeCorrelationId,
  runtimeEventVisibility,
} from './envelope'
import { RuntimeEventStore, compactReplayEvents } from './store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('runtime events (test_runtime_events.py)', () => {
  it('builds scheduler, external, session, task, and tool event payloads', () => {
    const job = { id: 'job-1', name: 'demo' }
    expect(
      runtimeEvents.userMessage({
        content: 'hello',
        attachments: [],
        clientMessageId: 'scheduler:job-1:turn-1',
        source: 'scheduler',
        scheduler: { jobId: 'job-1', jobName: 'demo' },
      }),
    ).toEqual({
      event: 'user_message',
      content: 'hello',
      attachments: [],
      client_message_id: 'scheduler:job-1:turn-1',
      source: 'scheduler',
      scheduler: { jobId: 'job-1', jobName: 'demo' },
    })
    expect(
      runtimeEvents.schedulerJobUpdate(job, { action: 'created' }),
    ).toEqual({ event: 'scheduler_job_update', job, action: 'created' })
    expect(runtimeEvents.schedulerRunStart(job).event).toBe(
      'scheduler_run_start',
    )
    expect(runtimeEvents.schedulerRunDone(job).event).toBe('scheduler_run_done')
    expect(runtimeEvents.schedulerRunCancelled(job).event).toBe(
      'scheduler_run_cancelled',
    )
    expect(
      runtimeEvents.schedulerRunSkipped(job, {
        run: { runId: 'run-1', taskId: 'task-1' },
        reason: 'capacity',
      }),
    ).toMatchObject({
      event: 'scheduler_run_skipped',
      run_id: 'run-1',
      task_id: 'task-1',
      reason: 'capacity',
    })
    expect(
      runtimeEvents.schedulerRunInterrupted(job, {
        run: { runId: 'run-2', taskId: 'task-2' },
        reason: 'shutdown',
      }),
    ).toMatchObject({
      event: 'scheduler_run_interrupted',
      run_id: 'run-2',
      task_id: 'task-2',
    })
    expect(runtimeEvents.schedulerRunError(job, { error: 'boom' }).error).toBe(
      'boom',
    )
    expect(
      runtimeEvents.runtimeTaskCancelled({ id: 'turn:1' }, { reason: 'stop' }),
    ).toEqual({
      event: 'runtime_task_cancelled',
      task: { id: 'turn:1' },
      reason: 'stop',
    })
    const mcpState = runtimeEvents.mcpConnectionStateChanged({
      serverName: 'docs',
      transport: 'stdio',
      generation: 2,
      clientId: 'mcp_client_2',
      state: 'ready',
      health: 'healthy',
      auth: 'ok',
      toolCount: 3,
      tools: ['search', 'read', 'list'],
      restartAttempts: 0,
      nextRetryAt: null,
      activeRequestCount: 0,
      activeRequestIds: [],
      lastError: null,
    })
    expect(mcpState).toMatchObject({
      event: 'mcp_connection_state',
      server_name: 'docs',
      generation: 2,
      client_id: 'mcp_client_2',
      state: 'ready',
      tool_count: 3,
    })
    expect(runtimeEventVisibility(String(mcpState.event))).toBe('diagnostic')

    const session = { id: 's1', title: '新会话' }
    expect(
      runtimeEvents.sessionCreated(session, { clientDraftId: 'draft-1' }),
    ).toEqual({
      event: 'session_created',
      session,
      client_draft_id: 'draft-1',
    })
    expect(runtimeEvents.sessionTitleUpdated(session)).toEqual({
      event: 'session_title_updated',
      session,
    })

    const task = { id: 'task_1', kind: 'subagent', status: 'running' }
    expect(runtimeEvents.taskStarted(task)).toEqual({
      event: 'task_started',
      task,
    })
    expect(runtimeEvents.taskProgress(task, { progress: { pct: 50 } })).toEqual(
      { event: 'task_progress', task, progress: { pct: 50 } },
    )
    expect(
      runtimeEvents.taskOutput(task, { offset: 1, chunk: 'hello' }),
    ).toEqual({ event: 'task_output', task, offset: 1, chunk: 'hello' })
    expect(runtimeEvents.taskError(task, { error: 'boom' })).toEqual({
      event: 'task_error',
      task,
      error: 'boom',
    })

    expect(
      runtimeEvents.contextProjection({
        report: { paired_missing_tool_results: 1 },
        messageCount: 3,
      }),
    ).toEqual({
      event: 'context_projection',
      report: { paired_missing_tool_results: 1 },
      message_count: 3,
    })
    expect(
      runtimeEvents.toolRunQueued({
        id: 'call_1',
        name: 'grep',
        arguments: { q: 'x' },
      }),
    ).toEqual({
      event: 'tool_run_queued',
      id: 'call_1',
      name: 'grep',
      arguments: { q: 'x' },
    })
    expect(
      runtimeEvents.recordDegraded({
        kind: 'runtime',
        reason: 'x'.repeat(600),
        taskId: 'task_1',
      }),
    ).toEqual({
      event: 'record_degraded',
      kind: 'runtime',
      reason: 'x'.repeat(500),
      taskId: 'task_1',
    })
  })

  it('bounds Environment events to identifiers, counts, and digests', () => {
    const event = runtimeEvents.environmentInstallProgress({
      jobId: 'job_1?token=secret',
      toolId: 'git; curl evil',
      stepId: 'step_1',
      status: 'running',
      completedSteps: -3,
      totalSteps: 99_999,
      errorCode: 'download_failed',
    })

    expect(event).toEqual({
      event: 'environment_install_progress',
      job_id: 'job_1tokensecret',
      tool_id: 'gitcurlevil',
      step_id: 'step_1',
      status: 'running',
      completed_steps: 0,
      total_steps: 10_000,
      error_code: 'download_failed',
    })
    expect(JSON.stringify(event)).not.toContain('token=secret')
  })

  it('builds all bounded Goal events without exposing raw content or paths', () => {
    const goal = {
      id: 'goal_1',
      status: 'active' as const,
      phase: 'executing' as const,
      outcome: 'Ship Goal mode',
      sessionId: 'session_1',
      currentPlanId: 'plan_1',
      cyclesUsed: 2,
      acceptance: { passed: 1, failed: 0, missing: 1, total: 2 },
      createdAt: '2026-07-16T01:00:00.000Z',
      updatedAt: '2026-07-16T01:02:03.000Z',
      lastEventSeq: 3,
      workspaceRoot: '/private/workspace',
      rawContent: 'secret tool output',
    }
    const identity = {
      goalId: goal.id,
      sessionId: goal.sessionId,
      lastEventSeq: 3,
      updatedAt: goal.updatedAt,
    }
    const lifecycle = [
      runtimeEvents.goalCreated(goal, { lastEventSeq: 1 }),
      runtimeEvents.goalRuntimeUpdate(goal, {
        lastEventSeq: 2,
        plan: { completed: 1, failed: 0, blocked: 0, total: 2 },
      }),
      runtimeEvents.goalPaused(goal, { lastEventSeq: 4, reason: 'review' }),
      runtimeEvents.goalResumed(goal, { lastEventSeq: 5 }),
      runtimeEvents.goalCompleted(
        { ...goal, status: 'completed' as const, phase: 'terminal' as const },
        { lastEventSeq: 6, summary: 'verified' },
      ),
      runtimeEvents.goalBlocked(
        { ...goal, status: 'blocked' as const, phase: 'terminal' as const },
        { lastEventSeq: 6, reason: 'external dependency' },
      ),
      runtimeEvents.goalCancelled(
        { ...goal, status: 'cancelled' as const, phase: 'terminal' as const },
        { lastEventSeq: 6, reason: 'user request' },
      ),
      runtimeEvents.goalPolicyStopped(
        {
          ...goal,
          status: 'stopped_by_policy' as const,
          phase: 'terminal' as const,
        },
        { lastEventSeq: 6, reason: 'cycle limit' },
      ),
    ]
    const evidence = runtimeEvents.goalEvidenceRecorded(goal, identity, {
      criterionId: 'ac_1',
      verdict: 'pass',
      sourceCount: 2,
      summary: 'focused tests passed',
      rawContent: 'must be ignored',
    } as Parameters<typeof runtimeEvents.goalEvidenceRecorded>[2])
    const gate = runtimeEvents.goalGateEvaluated(identity, {
      passed: false,
      reasonCodes: Array.from(
        { length: 25 },
        () => 'criterion_missing_evidence' as const,
      ),
      rawContent: 'must be ignored',
    } as Parameters<typeof runtimeEvents.goalGateEvaluated>[1])

    expect(lifecycle.map((event) => event.event)).toEqual([
      'goal_created',
      'goal_runtime_update',
      'goal_paused',
      'goal_resumed',
      'goal_completed',
      'goal_blocked',
      'goal_cancelled',
      'goal_policy_stopped',
    ])
    expect(evidence).toMatchObject({
      event: 'goal_evidence_recorded',
      goal_id: 'goal_1',
      criterion_id: 'ac_1',
      verdict: 'pass',
      source_count: 2,
    })
    expect(gate.reason_codes).toHaveLength(20)
    expect(gate.reason_count).toBe(25)
    for (const event of [...lifecycle, evidence, gate]) {
      const wire = JSON.stringify(event)
      expect(wire).not.toContain('workspaceRoot')
      expect(wire).not.toContain('/private/workspace')
      expect(wire).not.toContain('rawContent')
      expect(wire).not.toContain('secret tool output')
    }
  })
})

describe('RuntimeEventStore (test_runtime_events.py)', () => {
  it('writes V2 behind a flag, projects V1 wire events, and dedupes idempotency keys across restart', () => {
    const sessionRoot = join(
      tmp('emperor-runtime-envelope-v2-'),
      'sessions',
      'session_v2',
    )
    const store = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
      writeEnvelopeV2: true,
    })
    const first = store.append(
      { event: 'tool_run_started', id: 'call_1', name: 'grep' },
      {
        turnId: 'turn_1',
        requestId: 'req_1',
        attemptId: 'attempt_1',
        taskId: 'task_1',
        toolCallId: 'call_1',
        ownerId: 'task_1',
        idempotencyKey: 'tool:call_1:started',
        visibility: 'user',
      },
    )
    const duplicate = store.append(
      { event: 'tool_run_started', id: 'call_1', name: 'must-not-append' },
      { idempotencyKey: 'tool:call_1:started' },
    )

    expect(duplicate).toEqual(first)
    expect(first).toMatchObject({
      event: 'tool_run_started',
      seq: 1,
      session_id: 'session_v2',
      turn_id: 'turn_1',
      request_id: 'req_1',
      attempt_id: 'attempt_1',
      task_id: 'task_1',
      tool_call_id: 'call_1',
      schema_version: 2,
      visibility: 'user',
    })
    expect(String(first.event_id)).toMatch(/^evt_/)
    const rawLines = readFileSync(store.eventsFile, 'utf8').trim().split('\n')
    expect(rawLines).toHaveLength(1)
    expect(JSON.parse(rawLines[0]!)).toMatchObject({
      schemaVersion: 2,
      eventId: first.event_id,
      idempotencyKey: 'tool:call_1:started',
      sessionId: 'session_v2',
      sequence: 1,
      visibility: 'user',
      type: 'tool_run_started',
      payload: { id: 'call_1', name: 'grep' },
    })

    const reopened = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
      writeEnvelopeV2: true,
    })
    expect(
      reopened.append(
        { event: 'tool_run_started', id: 'call_1', name: 'still-duplicate' },
        { idempotencyKey: 'tool:call_1:started' },
      ),
    ).toEqual(first)
    expect(reopened.latestSeq).toBe(1)
    expect(reopened.replayEnvelopesAfter(0)[0]).toMatchObject({
      schemaVersion: 2,
      eventId: first.event_id,
      requestId: 'req_1',
      attemptId: 'attempt_1',
      taskId: 'task_1',
      toolCallId: 'call_1',
    })
  })

  it('opens mixed V1/V2 logs and assigns stable envelope ids to legacy events', () => {
    const sessionRoot = join(
      tmp('emperor-runtime-envelope-mixed-'),
      'sessions',
      'legacy_session',
    )
    const legacyStore = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
    })
    legacyStore.append(
      { event: 'user_message', content: 'legacy' },
      { turnId: 'legacy_turn' },
    )
    const v2Store = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
      writeEnvelopeV2: true,
    })
    v2Store.append(
      { event: 'assistant_done', content: 'new' },
      { turnId: 'legacy_turn', idempotencyKey: 'assistant:new' },
    )

    expect(v2Store.replayAfter(0).map((event) => event.event)).toEqual([
      'user_message',
      'assistant_done',
    ])
    const firstRead = v2Store.replayEnvelopesAfter(0)
    const secondRead = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
    }).replayEnvelopesAfter(0)
    expect(firstRead.map((event) => event.eventId)).toEqual(
      secondRead.map((event) => event.eventId),
    )
    expect(firstRead[0]).toMatchObject({
      schemaVersion: 2,
      sessionId: 'legacy_session',
      turnId: 'legacy_turn',
      sequence: 1,
      type: 'user_message',
      payload: { content: 'legacy' },
    })
    expect(firstRead[0]!.eventId).toMatch(/^evt_legacy_/)
  })

  it('preserves V2 envelopes and archived idempotency receipts through compaction', () => {
    const sessionRoot = join(
      tmp('emperor-runtime-envelope-compact-'),
      'sessions',
      'compact_session',
    )
    const store = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
      writeEnvelopeV2: true,
    })
    const archived = store.append(
      { event: 'assistant_done', content: 'archive me' },
      { turnId: 'turn_old', idempotencyKey: 'turn_old:done' },
    )
    store.append(
      { event: 'user_message', content: 'keep me' },
      { turnId: 'turn_active', idempotencyKey: 'turn_active:user' },
    )

    store.compact(['turn_active'])
    expect(
      JSON.parse(readFileSync(store.eventsFile, 'utf8').trim()),
    ).toMatchObject({ schemaVersion: 2, turnId: 'turn_active' })
    expect(
      store
        .replayEnvelopesAfter(0, { includeArchive: true })
        .map((event) => event.turnId),
    ).toEqual(['turn_old', 'turn_active'])

    const reopened = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
      writeEnvelopeV2: true,
    })
    expect(
      reopened.append(
        { event: 'assistant_done', content: 'must stay archived' },
        { idempotencyKey: 'turn_old:done' },
      ),
    ).toEqual(archived)
    expect(reopened.latestSeq).toBe(2)
  })

  it('keeps diagnostic envelope payloads out of the model-visible projection', () => {
    const root = tmp('emperor-runtime-envelope-visibility-')
    const store = new RuntimeEventStore(root, { writeEnvelopeV2: true })
    store.append(
      { event: 'partial_stream_capture', content: 'DIAGNOSTIC_SECRET' },
      { visibility: 'diagnostic', ownerId: 'request_1' },
    )
    store.append(
      { event: 'model_checkpoint', content: 'safe model context' },
      { visibility: 'model', ownerId: 'turn_1' },
    )

    const envelopes = store.replayEnvelopesAfter(0)
    expect(envelopes.map((event) => event.visibility)).toEqual([
      'diagnostic',
      'model',
    ])
    const modelPayloads = modelVisibleEnvelopePayloads(envelopes)
    expect(modelPayloads).toEqual([
      {
        event: 'model_checkpoint',
        content: 'safe model context',
        source: 'core',
      },
    ])
    expect(JSON.stringify(modelPayloads)).not.toContain('DIAGNOSTIC_SECRET')
  })

  it('reconstructs retry, parallel tool, and child-task correlation from V2 envelopes', () => {
    const sessionRoot = join(
      tmp('emperor-runtime-envelope-timeline-'),
      'sessions',
      'timeline_session',
    )
    const store = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
      writeEnvelopeV2: true,
    })
    const requestId = newRuntimeCorrelationId('request')
    const attempt1 = newRuntimeCorrelationId('attempt')
    const attempt2 = newRuntimeCorrelationId('attempt')
    const parentTaskId = newRuntimeCorrelationId('task')
    const childTaskId = newRuntimeCorrelationId('task')
    const toolA = newRuntimeCorrelationId('tool')
    const toolB = newRuntimeCorrelationId('tool')
    store.append(
      { event: 'model_attempt_started', attempt: 1 },
      { turnId: 'turn_timeline', requestId, attemptId: attempt1 },
    )
    store.append(
      { event: 'model_attempt_failed', attempt: 1 },
      { turnId: 'turn_timeline', requestId, attemptId: attempt1 },
    )
    store.append(
      { event: 'model_attempt_started', attempt: 2 },
      { turnId: 'turn_timeline', requestId, attemptId: attempt2 },
    )
    store.append(
      { event: 'tool_run_started', id: toolA, name: 'read_file' },
      {
        turnId: 'turn_timeline',
        requestId,
        attemptId: attempt2,
        taskId: parentTaskId,
        toolCallId: toolA,
      },
    )
    store.append(
      { event: 'tool_run_started', id: toolB, name: 'grep' },
      {
        turnId: 'turn_timeline',
        requestId,
        attemptId: attempt2,
        taskId: parentTaskId,
        toolCallId: toolB,
      },
    )
    store.append(
      { event: 'task_started', task: { id: childTaskId, kind: 'subagent' } },
      {
        turnId: 'turn_timeline',
        requestId,
        attemptId: attempt2,
        taskId: childTaskId,
        parentTaskId,
      },
    )

    const timeline = store.replayEnvelopesAfter(0)
    expect(timeline.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(
      new Set(timeline.map((event) => event.requestId).filter(Boolean)),
    ).toEqual(new Set([requestId]))
    expect(
      timeline
        .filter((event) => event.type.startsWith('model_attempt_'))
        .map((event) => event.attemptId),
    ).toEqual([attempt1, attempt1, attempt2])
    expect(
      timeline
        .filter((event) => event.type === 'tool_run_started')
        .map((event) => event.toolCallId),
    ).toEqual([toolA, toolB])
    expect(timeline.at(-1)).toMatchObject({
      taskId: childTaskId,
      parentTaskId,
    })
  })

  it('appends, recovers latest seq, replays, and filters bad lines', () => {
    const root = tmp('emperor-runtime-store-')
    const store = new RuntimeEventStore(root)

    const first = store.append(
      { event: 'user_message', content: 'hello' },
      { turnId: 'turn_1' },
    )
    const second = store.append(
      { event: 'tool_call', name: 'read_file' },
      { turnId: 'turn_1' },
    )
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(second.turn_id).toBe('turn_1')
    expect(new RuntimeEventStore(root).latestSeq).toBe(2)
    expect(store.replayAfter(1).map((event) => event.event)).toEqual([
      'tool_call',
    ])

    store.append({ event: 'user_message', content: 'b' }, { turnId: 'turn_b' })
    const eventsFile = join(root, 'memory', 'runtime', 'events.jsonl')
    const bad =
      readFileSync(eventsFile, 'utf8') +
      '{bad json\n' +
      JSON.stringify({ seq: 99, event: 'assistant_done', turn_id: 'turn_b' }) +
      '\n'
    writeFileSync(eventsFile, bad, 'utf8')
    expect(
      store.eventsForTurns(['turn_b']).map((event) => event.event),
    ).toEqual(['user_message', 'assistant_done'])
  })

  it('adds session receipts and filters replay by session owner', () => {
    const root = tmp('emperor-runtime-session-replay-')
    const sessionRoot = join(root, 'sessions', 'session_a')
    const store = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
    })

    const event = store.append(
      { event: 'user_message', content: 'hello' },
      { turnId: 'turn_a' },
    )

    expect(event).toMatchObject({
      seq: 1,
      event: 'user_message',
      source: 'core',
      session_id: 'session_a',
      turn_id: 'turn_a',
      owner: {
        session_id: 'session_a',
        turn_id: 'turn_a',
      },
    })
    expect(
      store
        .replayAfter(0, { sessionId: 'session_a' })
        .map((item) => item.content),
    ).toEqual(['hello'])
    expect(store.replayAfter(0, { sessionId: 'session_b' })).toEqual([])
  })

  it('infers legacy event session receipts from the session directory', () => {
    const sessionRoot = join(
      tmp('emperor-runtime-legacy-session-'),
      'sessions',
      'legacy_session',
    )
    const store = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
    })
    writeFileSync(
      store.eventsFile,
      JSON.stringify({
        seq: 7,
        event: 'assistant_done',
        turn_id: 'legacy_turn',
        content: 'done',
      }) + '\n',
      'utf8',
    )

    const replayed = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
    }).replayAfter(0, { sessionId: 'legacy_session' })

    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({
      session_id: 'legacy_session',
      owner: {
        session_id: 'legacy_session',
        turn_id: 'legacy_turn',
      },
    })
  })

  it('stats and compacts inactive turns to archive while keeping latest seq', () => {
    const root = tmp('emperor-runtime-compact-')
    const store = new RuntimeEventStore(root)
    store.append(
      { event: 'user_message', content: 'a', ts: 1_700_000_000 },
      { turnId: 'turn_a' },
    )
    store.append(
      { event: 'tool_call', name: 'read_file', ts: 1_700_000_001 },
      { turnId: 'turn_a' },
    )
    store.append(
      { event: 'user_message', content: 'b', ts: 1_700_000_002 },
      { turnId: 'turn_b' },
    )

    expect(store.stats({ activeTurnIds: ['turn_a'] })).toMatchObject({
      events: 3,
      latestSeq: 3,
      activeTurns: 1,
      activeTurnEvents: 2,
      path: 'memory/runtime/events.jsonl',
    })
    const stats = store.compact(['turn_b'])
    expect(store.replayAfter(0).map((event) => event.turn_id)).toEqual([
      'turn_b',
    ])
    expect(
      store
        .replayAfter(0, { includeArchive: true })
        .map((event) => event.turn_id),
    ).toEqual(['turn_a', 'turn_a', 'turn_b'])
    expect(
      store
        .replayAfter(2, { includeArchive: true })
        .map((event) => event.turn_id),
    ).toEqual(['turn_b'])
    expect(stats.events).toBe(1)
    expect(stats.archiveFiles).toBe(1)
    expect(stats.archiveBytes).toBeGreaterThan(0)
    expect(new RuntimeEventStore(root).latestSeq).toBe(3)
    expect(existsSync(join(root, 'memory', 'runtime', 'archive'))).toBe(true)
  })

  it('supports session directory override', () => {
    const sessionRoot = join(tmp('emperor-runtime-session-'), 'sessions', 'aaa')
    const store = new RuntimeEventStore(sessionRoot, {
      sessionDirOverride: true,
    })
    store.append({ event: 'ready' })
    expect(store.stats().path).toBe('runtime/events.jsonl')
  })
})

describe('ActiveTaskRegistry (test_active_tasks.py)', () => {
  it('registers before starting work and never starts a duplicate factory', async () => {
    const registry = new ActiveTaskRegistry()
    let release: () => void = () => {}
    let firstCalls = 0
    let duplicateCalls = 0
    const first = registry.run({
      taskId: 'scheduler:job_1',
      kind: 'scheduler',
      label: 'Scheduler job',
      execute: async () => {
        firstCalls += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return 'done'
      },
    })
    await Promise.resolve()

    const duplicate = registry.run({
      taskId: 'scheduler:job_1',
      kind: 'scheduler',
      label: 'Duplicate scheduler job',
      execute: async () => {
        duplicateCalls += 1
        return 'duplicate'
      },
    })

    await expect(duplicate).rejects.toThrow('active task already exists')
    expect(firstCalls).toBe(1)
    expect(duplicateCalls).toBe(0)
    release()
    await expect(first).resolves.toBe('done')
  })

  it('cancels matching tasks and updates metadata', async () => {
    const registry = new ActiveTaskRegistry()
    let resolveWork: (value: string) => void = () => {}
    const runPromise = registry.run({
      taskId: 'scheduler:job_1',
      kind: 'scheduler',
      label: 'Scheduler job',
      execute: () =>
        new Promise<string>((resolve) => {
          resolveWork = resolve
        }),
      jobId: 'job_1',
      sessionId: 'sess_scheduler',
    })

    const info = registry.update('scheduler:job_1', {
      turnId: 'turn_scheduler',
      sessionId: 'sess_scheduler_updated',
    })
    expect(info?.turn_id).toBe('turn_scheduler')
    expect(info?.session_id).toBe('sess_scheduler_updated')
    expect(activeTaskToDict(info!)).toMatchObject({
      turnId: 'turn_scheduler',
      session_id: 'sess_scheduler_updated',
      sessionId: 'sess_scheduler_updated',
    })
    expect(registry.list()).toHaveLength(1)
    expect(registry.hasActiveForSession('sess_scheduler_updated')).toBe(true)
    expect(
      registry.hasActiveForSession('sess_scheduler_updated', 'scheduler'),
    ).toBe(true)
    expect(registry.hasActiveForSession('other_session')).toBe(false)
    resolveWork('done')
    await expect(runPromise).resolves.toBe('done')
    expect(registry.list()).toEqual([])

    const never = registry.run({
      taskId: 'watchlist:manual-check',
      kind: 'watchlist',
      label: 'Watchlist manual check',
      execute: () => new Promise(() => {}),
    })
    const cancelled = registry.cancel({ kind: 'watchlist' })
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]!.cancelled).toBe(true)
    await expect(never).rejects.toBeInstanceOf(CancelledTaskError)
    expect(registry.list()).toEqual([])
  })
})

describe('compactReplayEvents (P1-5 replay compaction)', () => {
  it('only collapses adjacent updates for the same Goal and preserves audit events', () => {
    const rows = [
      { event: 'goal_runtime_update', goal_id: 'g1', last_event_seq: 1 },
      { event: 'goal_runtime_update', goal_id: 'g1', last_event_seq: 2 },
      { event: 'goal_evidence_recorded', goal_id: 'g1', last_event_seq: 3 },
      { event: 'goal_runtime_update', goal_id: 'g1', last_event_seq: 4 },
      { event: 'goal_runtime_update', goal_id: 'g2', last_event_seq: 1 },
      {
        event: 'goal_gate_evaluated',
        goal_id: 'g1',
        last_event_seq: 5,
        passed: false,
      },
      { event: 'goal_paused', goal_id: 'g1', last_event_seq: 6 },
      { event: 'goal_completed', goal_id: 'g1', last_event_seq: 7 },
    ]

    expect(compactReplayEvents(rows)).toEqual([
      rows[1],
      rows[2],
      rows[3],
      rows[4],
      rows[5],
      rows[6],
      rows[7],
    ])
  })

  it('collapses contiguous plan_draft_delta runs to the last event per stream', () => {
    const rows = [
      { event: 'user_message', seq: 1, turn_id: 't1', content: 'go' },
      {
        event: 'plan_draft_delta',
        seq: 2,
        turn_id: 't1',
        tool_call_id: 'c1',
        interaction: { id: 'p', title: 'A', meta: { plan_stream_id: 'c1' } },
      },
      {
        event: 'plan_draft_delta',
        seq: 3,
        turn_id: 't1',
        tool_call_id: 'c1',
        interaction: { id: 'p', title: 'AB', meta: { plan_stream_id: 'c1' } },
      },
      {
        event: 'plan_draft_delta',
        seq: 4,
        turn_id: 't1',
        tool_call_id: 'c1',
        interaction: { id: 'p', title: 'ABC', meta: { plan_stream_id: 'c1' } },
      },
      {
        event: 'plan_draft',
        seq: 5,
        turn_id: 't1',
        interaction: { id: 'plan_1' },
      },
      { event: 'assistant_done', seq: 6, turn_id: 't1', content: 'done' },
    ]

    const out = compactReplayEvents(rows)

    expect(out.map((event) => [event.event, event.seq])).toEqual([
      ['user_message', 1],
      ['plan_draft_delta', 4],
      ['plan_draft', 5],
      ['assistant_done', 6],
    ])
    expect(out[1]!.interaction.title).toBe('ABC')
  })

  it('merges contiguous message_delta runs keeping the first seq and joined text', () => {
    const rows = [
      { event: 'message_delta', seq: 1, turn_id: 't1', delta: '你' },
      { event: 'message_delta', seq: 2, turn_id: 't1', delta: '好' },
      { event: 'message_delta', seq: 3, turn_id: 't1', delta: '。' },
      { event: 'tool_call', seq: 4, turn_id: 't1', id: 'call_1', name: 'grep' },
      { event: 'message_delta', seq: 5, turn_id: 't1', delta: '继续' },
      { event: 'message_delta', seq: 6, turn_id: 't2', delta: '另一轮' },
    ]

    const out = compactReplayEvents(rows)

    expect(
      out.map((event) => [event.event, event.seq, event.delta ?? null]),
    ).toEqual([
      ['message_delta', 1, '你好。'],
      ['tool_call', 4, null],
      ['message_delta', 5, '继续'],
      ['message_delta', 6, '另一轮'],
    ])
  })

  it('leaves non-delta events untouched and preserves total text', () => {
    const rows = [
      { event: 'user_message', seq: 1, turn_id: 't1', content: 'hi' },
      { event: 'message_delta', seq: 2, turn_id: 't1', delta: 'a' },
      {
        event: 'agent_thought',
        seq: 3,
        turn_id: 't1',
        stage: 's',
        summary: 'x',
      },
      { event: 'message_delta', seq: 4, turn_id: 't1', delta: 'b' },
      { event: 'assistant_done', seq: 5, turn_id: 't1', content: 'ab' },
    ]

    const out = compactReplayEvents(rows)

    expect(out).toHaveLength(5)
    const joined = out
      .filter((event) => event.event === 'message_delta')
      .map((event) => event.delta)
      .join('')
    expect(joined).toBe('ab')
    expect(out[0]).toEqual(rows[0])
    expect(out[4]).toEqual(rows[4])
  })

  it('replayAfter applies compaction when asked without touching the disk file', () => {
    const root = tmp('emperor-runtime-compact-')
    const store = new RuntimeEventStore(root)
    store.append({ event: 'user_message', content: 'go' }, { turnId: 't1' })
    for (let index = 0; index < 5; index += 1) {
      store.append(
        {
          event: 'plan_draft_delta',
          tool_call_id: 'c1',
          interaction: {
            id: 'p',
            title: 'T'.repeat(index + 1),
            meta: { plan_stream_id: 'c1' },
          },
        },
        { turnId: 't1' },
      )
    }
    store.append({ event: 'assistant_done', content: 'done' }, { turnId: 't1' })

    const compacted = store.replayAfter(0, { compact: true })
    const full = store.replayAfter(0)

    expect(full).toHaveLength(7)
    expect(compacted.map((event) => event.event)).toEqual([
      'user_message',
      'plan_draft_delta',
      'assistant_done',
    ])
    expect(compacted[1]!.interaction.title).toBe('TTTTT')
    const eventsFile = join(root, 'memory', 'runtime', 'events.jsonl')
    expect(readFileSync(eventsFile, 'utf8').trim().split('\n')).toHaveLength(7)
  })
})

describe('index write throttle (2026-07-05 B6)', () => {
  it('does not rewrite index.json on every append; terminal events force a write', async () => {
    const { mkdtempSync, readFileSync, statSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { RuntimeEventStore } = await import('./store')
    const root = mkdtempSync(join(tmpdir(), 'emperor-index-throttle-'))
    const store = new RuntimeEventStore(root)

    let indexWrites = 0
    let lastMtime = 0
    const indexPath = store.indexFile
    const mtime = () => {
      try {
        return statSync(indexPath).mtimeMs + statSync(indexPath).size / 1e9
      } catch {
        return 0
      }
    }
    lastMtime = mtime()
    for (let i = 0; i < 100; i++) {
      store.append({ event: 'message_delta', delta: 'x', turn_id: 't1' })
      const m = mtime()
      if (m !== lastMtime) {
        indexWrites++
        lastMtime = m
      }
    }
    // 100 条高频 delta 期间 index 重写次数远小于 append 次数
    expect(indexWrites).toBeLessThan(10)
    expect(store.latestSeq).toBe(100)

    store.append({ event: 'assistant_done', content: 'done', turn_id: 't1' })
    const index = JSON.parse(readFileSync(indexPath, 'utf8'))
    // 终态事件强制落盘，index 追平真实计数
    expect(Number(index.events)).toBe(101)
    expect(Number(index.latestSeq)).toBe(101)
  })
})
