// SEC-03 (PLAN-V020, CORE-3 / CORE-43): after a crash, opening a session
// closes every marker pair the dead process left open — compaction, workflow
// runs and members, background jobs, delegated children — in the order they
// were opened, once, and marked as repaired.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { userText } from '../../llm/message'
import type { Session } from '../../session-log/session'
import { SessionLogStore } from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import { CompactionEngine } from '../compaction/engine'
import { SessionProjector } from '../projection/projector'
import { createTestHarness } from '../testing'
import { WorkflowRunFold } from '../workflow/records'
import { REPAIR_CONTRIBUTORS } from './repair-contributors'

function store(root = mkdtempSync(join(tmpdir(), 'repair-matrix-'))) {
  return new SessionLogStore({
    root,
    writeBatchMaxDelayMs: 1,
    repairContributors: [...REPAIR_CONTRIBUTORS],
  })
}

function append(session: Session, type: string, data: unknown): void {
  ;(session.append as (type: string, data: unknown) => void).call(
    session,
    type,
    data,
  )
}

/** Write a log, "crash" (close without closers), reopen with repair. */
function crashAndReopen(write: (session: Session) => void): {
  session: Session
  s: SessionLogStore
  before: number
} {
  const s = store()
  const session = s.create({ id: 'x' })
  write(session)
  const before = session.events.length
  s.close('x')
  const fresh = store(s.root)
  return { session: fresh.open('x'), s: fresh, before }
}

const tail = (session: Session, before: number): SessionEvent[] =>
  session.events.slice(before)

describe('crash repair contributors', () => {
  it('closes an interrupted compaction so /compact works again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-compaction-'))
    const first = createTestHarness({ root })
    first.adapter.push({ text: 'w'.repeat(3000) }, { text: 'second answer' })
    const agent = first.agent('c')
    agent.followup(userText('hello'))
    await agent.whenIdle()
    agent.followup(userText('again'))
    await agent.whenIdle()
    append(agent.session, 'compaction/start', {
      compactionId: 'k1',
      turn: null,
    })
    first.sessions.close('c')

    const h = createTestHarness({ root })
    for (const contributor of REPAIR_CONTRIBUTORS)
      h.sessions.addRepairContributor(contributor)
    const reopened = h.agent('c')
    expect(reopened.session.lastOf('compaction/end')?.data).toEqual({
      compactionId: 'k1',
      turn: null,
      error: 'interrupted',
      repaired: true,
    })
    const engine = new CompactionEngine(h.llm, undefined, { auto: false })
    h.adapter.push([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'short' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(engine.compactNow(reopened)).resolves.toBeDefined()
  })

  it('closes a compaction whose summary already landed without an error', () => {
    const { session, before } = crashAndReopen((s) => {
      append(s, 'compaction/start', { compactionId: 'k2', turn: null })
      append(s, 'compaction/summary', {
        compactionId: 'k2',
        summary: [{ type: 'text', text: 's' }],
        shadowedRange: { start: 0, end: 0 },
        shadowedSeqs: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      })
    })
    expect(tail(session, before).map((e) => e.data)).toEqual([
      { compactionId: 'k2', turn: null, repaired: true },
    ])
  })

  it('ends an interrupted workflow run and its open members', () => {
    const { session, before } = crashAndReopen((s) => {
      append(s, 'tool-workflow/run-start', { runId: 'r1', name: 'review' })
      append(s, 'tool-workflow/agent-start', {
        runId: 'r1',
        seq: 1,
        label: 'a',
        childId: 'c1',
      })
      append(s, 'tool-workflow/agent-start', {
        runId: 'r1',
        seq: 2,
        label: 'b',
        childId: 'c2',
      })
      append(s, 'tool-workflow/agent-end', {
        runId: 'r1',
        seq: 1,
        outcome: 'completed',
      })
    })
    expect(tail(session, before).map((e) => [e.type, e.data] as const)).toEqual(
      [
        [
          'tool-workflow/agent-end',
          { runId: 'r1', seq: 2, outcome: 'cancelled', repaired: true },
        ],
        [
          'tool-workflow/run-end',
          {
            runId: 'r1',
            stopReason: 'interrupted',
            error: 'interrupted',
            repaired: true,
          },
        ],
      ],
    )
    expect(WorkflowRunFold.fold(session.events)[0]?.status).toBe('interrupted')
    const projected = SessionProjector.projectAll(session.events, {
      sessionId: 'x',
    })
    expect(
      projected.find((e) => e.event === 'workflow_finished'),
    ).toMatchObject({ task: { status: 'interrupted' } })
  })

  it('settles a background job and a delegated child the crash cut short', () => {
    const { session, before } = crashAndReopen((s) => {
      append(s, 'job/started', {
        jobId: 'j1',
        kind: 'bash',
        command: 'sleep 9',
      })
      append(s, 'subagent/started', {
        subagentId: 'child-1',
        description: 'look around',
        mode: 'spawn',
        background: true,
      })
    })
    expect(tail(session, before).map((e) => [e.type, e.data] as const)).toEqual(
      [
        [
          'job/finished',
          {
            jobId: 'j1',
            kind: 'bash',
            command: 'sleep 9',
            status: 'killed',
            detail: 'interrupted',
            repaired: true,
          },
        ],
        [
          'subagent/settled',
          { subagentId: 'child-1', stopReason: 'interrupted', repaired: true },
        ],
      ],
    )
  })

  it('leaves closed markers alone', () => {
    const { session, before } = crashAndReopen((s) => {
      append(s, 'compaction/start', { compactionId: 'k', turn: null })
      append(s, 'compaction/end', { compactionId: 'k', turn: null })
      append(s, 'job/started', { jobId: 'j', kind: 'bash', command: 'true' })
      append(s, 'job/finished', {
        jobId: 'j',
        kind: 'bash',
        command: 'true',
        status: 'completed',
      })
      append(s, 'tool-workflow/run-start', { runId: 'r', name: 'n' })
      append(s, 'tool-workflow/run-end', {
        runId: 'r',
        stopReason: 'completed',
      })
    })
    expect(tail(session, before)).toEqual([])
  })

  it('closes several open markers in the order they were opened', () => {
    const { session, before } = crashAndReopen((s) => {
      append(s, 'job/started', { jobId: 'j', kind: 'bash', command: 'x' })
      append(s, 'approval/asked', { id: 'a1', request: {} })
      append(s, 'compaction/start', { compactionId: 'k', turn: null })
      append(s, 'question/asked', { id: 'q1', questions: [] })
    })
    expect(tail(session, before).map((e) => e.type)).toEqual([
      'job/finished',
      'approval/decided',
      'compaction/end',
      'question/answered',
    ])
  })

  it('shows a repaired compaction as interrupted by the app, not as a failure text', () => {
    const { session } = crashAndReopen((s) => {
      append(s, 'compaction/start', { compactionId: 'k3', turn: null })
    })
    const projected = SessionProjector.projectAll(session.events, {
      sessionId: 'x',
    })
    expect(
      projected.filter((e) => e.thought_id === 'compaction:k3').at(-1),
    ).toMatchObject({ status: 'error', summary: '应用中断，压缩未完成' })
  })

  it('repairs once: a second crash after the repair adds nothing', () => {
    const { session, s, before } = crashAndReopen((x) => {
      append(x, 'compaction/start', { compactionId: 'k', turn: null })
      append(x, 'tool-workflow/run-start', { runId: 'r', name: 'n' })
      append(x, 'job/started', { jobId: 'j', kind: 'bash', command: 'x' })
    })
    const repaired = session.events.length
    expect(repaired).toBeGreaterThan(before)
    s.close('x')
    expect(store(s.root).open('x').events).toHaveLength(repaired)
  })
})
