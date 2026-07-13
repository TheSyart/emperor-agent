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

    const message = { platform: 'fake', external_message_id: 'm1' }
    expect(runtimeEvents.externalInbound(message)).toEqual({
      event: 'external_inbound',
      message,
    })
    expect(
      runtimeEvents.externalQueued(message, { reason: 'busy' }).reason,
    ).toBe('busy')
    expect(
      runtimeEvents.externalOutboundSent(message, { delivery: { ok: true } })
        .delivery,
    ).toEqual({ ok: true })

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
})

describe('RuntimeEventStore (test_runtime_events.py)', () => {
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
