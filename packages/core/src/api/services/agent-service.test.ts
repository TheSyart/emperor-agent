import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionLogStore } from '../../session-log/store'
import { tmp } from '../test-helpers'
import {
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from '../../harness/delegation/testing'
import type { SubagentRecord } from '../../harness/subagent/manager'
import type { DelegationState } from '../../harness/delegation/fold'
import { CoreAgentService } from './agent-service'
import {
  agentTitle,
  agentSourceLabel,
  agentPhaseLabel,
} from '../../runtime/agent-view'

function external(
  id: string,
  root = 'root',
  parent = root,
  backend: 'codex' | 'claude-code' = 'codex',
): DelegationState {
  const record = { ...fixtureDelegationRecord(), id, backend }
  record.owner = { ...record.owner, rootSessionId: root, parentAgentId: parent }
  record.startSpec = {
    backend,
    description: '  Exact creation task  ',
    prompt: 'do it',
    context: 'isolated',
    workspace: 'shared-readonly',
    base: 'committed',
    runInBackground: true,
    clientRequestId: id,
  }
  const run = {
    ...fixtureDelegationRun('dgr-one'),
    delegationId: id,
    phase: 'completed' as const,
    finishedAt: 30,
  }
  record.currentRunId = run.id
  return {
    record,
    runs: { [run.id]: run },
    messages: {},
    interactions: {},
    outbox: {},
    lastSeq: 3,
  }
}
function fixture(states: DelegationState[] = []) {
  const root = tmp('agent-index-')
  const sessions = new SessionLogStore({ root })
  sessions.create({ id: 'root', createdAt: 1 })
  const changes: { rootSessionId: string; revision: number }[] = []
  let reads = 0
  const live = new Map<string, SubagentRecord>()
  const waiting = new Set<string>()
  const snapshotReads = vi.spyOn(sessions, 'readSnapshot')
  const service = new CoreAgentService({
    sessions,
    roots: () => ['root', 'foreign'],
    external: () => {
      reads++
      return states
    },
    live: (id) => live.get(id),
    waiting: (id) => waiting.has(id),
    changed: (event) => changes.push(event),
  })
  return {
    root,
    sessions,
    service,
    changes,
    live,
    waiting,
    snapshotReads,
    reads: () => reads,
  }
}
function child(
  f: ReturnType<typeof fixture>,
  id: string,
  parent: string,
  description = 'Exact internal task',
) {
  const session = f.sessions.create({
    id,
    parentSession: parent,
    origin: 'subagent',
    createdAt: 10,
  })
  session.append('subagent/descriptor', {
    parentSession: parent,
    description,
    mode: 'spawn',
    parentCallId: 'call-1',
  })
  f.sessions.get(parent)?.append('subagent/started', {
    subagentId: id,
    description,
    mode: 'spawn',
    background: true,
  })
  f.sessions
    .get(parent)
    ?.append('subagent/settled', { subagentId: id, stopReason: 'completed' })
  return session
}

describe('unified child-agent read index', () => {
  it('uses creation descriptions verbatim and separate provider/phase labels', () => {
    expect(agentTitle('  exact task  ', 'codex')).toBe('  exact task  ')
    expect(agentTitle('', 'internal')).toBe('Emperor 子智能体')
    expect(agentTitle(undefined, 'claude-code')).toBe('Claude Code 子智能体')
    expect(agentTitle('   ', 'codex')).toBe('Codex 子智能体')
    expect(agentSourceLabel('internal')).toBe('Emperor')
    expect(agentPhaseLabel('waiting')).toBe('等待回答')
    expect(agentPhaseLabel('unknown')).toBe('结果待确认')
  })
  it('rebuilds all providers under actual parents with stable conversation identities across runs', () => {
    const a = external('dlg-codex', 'root', 'sub-parent'),
      b = external('dlg-claude', 'root', 'root', 'claude-code')
    const f = fixture([a, b, external('dlg-foreign', 'foreign')])
    child(f, 'sub-parent', 'root')
    child(f, 'sub-nested', 'sub-parent')
    const rows = f.service.list(['root']).agents
    expect(rows.map((r) => r.id).sort()).toEqual([
      'dlg-claude',
      'dlg-codex',
      'sub-nested',
      'sub-parent',
    ])
    expect(rows.find((r) => r.id === 'dlg-codex')).toMatchObject({
      kind: 'external',
      backend: 'codex',
      rootSessionId: 'root',
      parentAgentId: 'sub-parent',
      title: '  Exact creation task  ',
      phase: 'completed',
      currentRunId: 'dgr-one',
    })
    expect(rows.find((r) => r.id === 'sub-nested')).toMatchObject({
      kind: 'internal',
      backend: 'internal',
      parentAgentId: 'sub-parent',
      phase: 'completed',
    })
    a.record!.currentRunId = 'dgr-two'
    a.runs['dgr-two'] = {
      ...fixtureDelegationRun('dgr-two'),
      delegationId: 'dlg-codex',
      phase: 'waiting_input',
      startedAt: 40,
    }
    f.service.externalChanged(a)
    expect(
      f.service.list(['root']).agents.find((r) => r.id === 'dlg-codex'),
    ).toMatchObject({
      id: 'dlg-codex',
      currentRunId: 'dgr-two',
      phase: 'waiting',
    })
    f.sessions.closeAll()
  })
  it('ignores fork seeds and ordinary chat forks, omits cycles, and marks retained missing logs', () => {
    const f = fixture()
    const parent = child(f, 'sub-parent', 'root')
    child(f, 'sub-original', 'sub-parent')
    const fork = f.sessions.fork('sub-parent', 'sub-fork', {
      origin: 'subagent',
    })
    fork.append('subagent/descriptor', {
      parentSession: 'sub-parent',
      description: 'fork task',
      mode: 'fork',
    })
    f.sessions.fork('sub-parent', 'ordinary-fork')
    child(f, 'sub-cycle-a', 'sub-cycle-b')
    child(f, 'sub-cycle-b', 'sub-cycle-a')
    parent.append('subagent/started', {
      subagentId: 'sub-missing',
      description: 'lost log',
      mode: 'spawn',
      background: true,
    })
    const rows = f.service.list(['root']).agents
    expect(rows.map((r) => r.id).sort()).toEqual([
      'sub-fork',
      'sub-missing',
      'sub-original',
      'sub-parent',
    ])
    expect(rows.find((r) => r.id === 'sub-original')?.parentAgentId).toBe(
      'sub-parent',
    )
    expect(rows.find((r) => r.id === 'sub-missing')).toMatchObject({
      phase: 'unknown',
      unavailable: 'missing_log',
    })
    f.sessions.closeAll()
  })
  it('restarts from headers and facts without repairing, executing, or requiring a manager record', () => {
    const f = fixture([external('dlg-codex')])
    const session = child(f, 'sub-old', 'root')
    session.append('turn/start', { turn: 1 })
    f.sessions.closeAll()
    const path = join(f.root, 'sub-old', 'log.jsonl'),
      before = readFileSync(path, 'utf8')
    const row = f.service.list(['root']).agents.find((r) => r.id === 'sub-old')
    expect(row).toMatchObject({
      title: 'Exact internal task',
      phase: 'unknown',
      stopReason: 'interrupted',
    })
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(f.sessions.list()).toHaveLength(0)
  })
  it('isolates corrupt/missing logs and foreign parents without losing readable siblings', () => {
    const f = fixture([
      external('dlg-orphan', 'root', 'sub-gone'),
      external('dlg-wrong', 'root', 'sub-foreign'),
    ])
    child(f, 'sub-ok', 'root')
    child(f, 'sub-foreign', 'foreign')
    f.sessions.get('root')!.append('subagent/started', {
      subagentId: 'sub-corrupt',
      description: 'broken',
      mode: 'spawn',
      background: false,
    })
    mkdirSync(join(f.root, 'sub-corrupt'))
    writeFileSync(join(f.root, 'sub-corrupt', 'log.jsonl'), '{invalid}\n')
    const rows = f.service.list(['root']).agents
    expect(rows.find((r) => r.id === 'sub-ok')).toBeDefined()
    expect(rows.find((r) => r.id === 'sub-corrupt')).toMatchObject({
      unavailable: 'corrupt_log',
      phase: 'unknown',
    })
    expect(rows.find((r) => r.id === 'dlg-orphan')).toMatchObject({
      parentAgentId: 'sub-gone',
      unavailable: 'missing_parent',
    })
    expect(rows.find((r) => r.id === 'dlg-wrong')).toMatchObject({
      unavailable: 'foreign_parent',
    })
    expect(rows.some((r) => r.id === 'sub-foreign')).toBe(false)
    f.sessions.closeAll()
  })
  it('preserves the own descriptor actual parent when a corrupt header or parent claim disagrees', () => {
    const f = fixture()
    child(f, 'sub-parent', 'root')
    const session = f.sessions.create({
      id: 'sub-conflict',
      parentSession: 'root',
      origin: 'subagent',
      createdAt: 20,
    })
    session.append('subagent/descriptor', {
      parentSession: 'sub-parent',
      description: 'actual task',
      mode: 'spawn',
    })
    f.sessions.get('root')!.append('subagent/started', {
      subagentId: session.id,
      description: 'stale claim',
      mode: 'spawn',
      background: true,
    })
    expect(
      f.service.list(['root']).agents.find((r) => r.id === session.id),
    ).toMatchObject({
      parentAgentId: 'sub-parent',
      title: 'actual task',
      unavailable: 'conflicting_parent',
    })
    f.sessions.closeAll()
  })
  it.each([
    {
      name: 'parent validation corrects a completed child turn',
      marker: true,
      sameTime: false,
      continuation: 'none',
      phase: 'failed',
      reason: 'error',
    },
    {
      name: 'later open turn supersedes the prior settlement',
      marker: true,
      sameTime: false,
      continuation: 'open',
      phase: 'unknown',
      reason: 'interrupted',
    },
    {
      name: 'later closed turn supersedes the prior settlement',
      marker: true,
      sameTime: false,
      continuation: 'closed',
      phase: 'completed',
      reason: 'completed',
    },
    {
      name: 'event identity disambiguates a later open turn in the same millisecond',
      marker: true,
      sameTime: true,
      continuation: 'open',
      phase: 'unknown',
      reason: 'interrupted',
    },
    {
      name: 'event identity disambiguates a later closed turn in the same millisecond',
      marker: true,
      sameTime: true,
      continuation: 'closed',
      phase: 'completed',
      reason: 'completed',
    },
    {
      name: 'event identity preserves parent validation in the same millisecond',
      marker: true,
      sameTime: true,
      continuation: 'none',
      phase: 'failed',
      reason: 'error',
    },
    {
      name: 'legacy same-millisecond open continuation remains interrupted',
      marker: false,
      sameTime: true,
      continuation: 'open',
      phase: 'unknown',
      reason: 'interrupted',
    },
    {
      name: 'legacy same-millisecond closed continuation cannot prove its final settlement',
      marker: false,
      sameTime: true,
      continuation: 'closed',
      phase: 'unknown',
      reason: undefined,
    },
    {
      name: 'legacy later parent validation remains authoritative',
      marker: false,
      sameTime: false,
      continuation: 'none',
      phase: 'failed',
      reason: 'error',
    },
    {
      name: 'legacy later open turns supersede earlier settlements',
      marker: false,
      sameTime: false,
      continuation: 'open',
      phase: 'unknown',
      reason: 'interrupted',
    },
    {
      name: 'legacy later closed turns supersede earlier settlements',
      marker: false,
      sameTime: false,
      continuation: 'closed',
      phase: 'completed',
      reason: 'completed',
    },
    {
      name: 'legacy equal timestamps with conflicting final states remain unknown',
      marker: false,
      sameTime: true,
      continuation: 'none',
      phase: 'unknown',
      reason: undefined,
    },
  ])(
    'folds durable native chronology: $name',
    ({ marker, sameTime, continuation, phase, reason }) => {
      let now = 1000
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
      const f = fixture()
      try {
        const session = child(f, 'sub-chronology', 'root')
        session.append('turn/start', { turn: 1 })
        if (!sameTime) now = 1100
        const ended = session.append('turn/end', {
          turn: 1,
          reason: { kind: 'completed' },
        })
        if (!sameTime) now = 1200
        f.sessions.get('root')!.append('subagent/settled', {
          subagentId: session.id,
          stopReason: 'error',
          ...(marker ? { childTurnEndSeq: ended.seq } : {}),
        })
        if (continuation !== 'none') {
          if (!sameTime) now = 1300
          session.append('turn/start', { turn: 2 })
          if (continuation === 'closed') {
            if (!sameTime) now = 1400
            session.append('turn/end', {
              turn: 2,
              reason: { kind: 'completed' },
            })
          }
        }
        const before = f.service
          .list(['root'])
          .agents.find((row) => row.id === session.id)
        expect(before?.phase).toBe(phase)
        expect(before?.stopReason).toBe(reason)
        f.sessions.closeAll()
        f.service.rebuild()
        const after = f.service
          .list(['root'])
          .agents.find((row) => row.id === session.id)
        expect(after?.phase).toBe(phase)
        expect(after?.stopReason).toBe(reason)
      } finally {
        f.sessions.closeAll()
        clock.mockRestore()
      }
    },
  )
  it('reconstructs header-only older children from their actual parent creation and settlement facts', () => {
    const f = fixture()
    f.sessions.create({
      id: 'sub-legacy',
      origin: 'subagent',
      parentSession: 'root',
      createdAt: 10,
    })
    const root = f.sessions.get('root')!
    root.append('subagent/started', {
      subagentId: 'sub-legacy',
      description: 'legacy creation description',
      mode: 'spawn',
      background: true,
      callId: 'legacy-call',
    })
    root.append('subagent/settled', {
      subagentId: 'sub-legacy',
      stopReason: 'error',
    })
    expect(f.service.list(['root']).agents).toEqual([
      expect.objectContaining({
        id: 'sub-legacy',
        parentAgentId: 'root',
        title: 'legacy creation description',
        parentCallId: 'legacy-call',
        phase: 'failed',
        stopReason: 'error',
      }),
    ])
    f.sessions.closeAll()
  })
  it('tracks waiting native children and does not invent completion after an interrupted restart', async () => {
    const f = fixture()
    const session = child(f, 'sub-wait', 'root')
    f.live.set(session.id, {
      id: session.id,
      parentId: 'root',
      description: 'task',
      mode: 'spawn',
      depth: 1,
      createdAt: 10,
      status: 'running',
    })
    session.append('turn/start', { turn: 1 })
    f.service.list(['root'])
    f.waiting.add(session.id)
    f.service.sessionChanged(session.id)
    await Promise.resolve()
    expect(f.service.list(['root']).agents[0]?.phase).toBe('waiting')
    f.waiting.clear()
    f.service.sessionChanged(session.id)
    await Promise.resolve()
    expect(f.service.list(['root']).agents[0]?.phase).toBe('running')
    expect(f.changes.map((c) => c.revision)).toEqual([1, 2])
    f.live.clear()
    f.service.rebuild()
    expect(f.service.list(['root']).agents[0]).toMatchObject({
      phase: 'unknown',
      stopReason: 'interrupted',
    })
    f.sessions.closeAll()
  })
  it('marks cyclic external ancestors without treating delegation IDs as native logs', () => {
    const f = fixture([
      external('dlg-a', 'root', 'dlg-b'),
      external('dlg-b', 'root', 'dlg-a'),
    ])
    expect(f.service.list(['root']).agents.map((r) => r.unavailable)).toEqual([
      'cyclic_parent',
      'cyclic_parent',
    ])
    expect(f.snapshotReads.mock.calls.flat()).not.toContain('dlg-a')
    f.sessions.closeAll()
  })
  it('keeps run phases distinct and preserves completed facts when workspace recovery is required', () => {
    const states = [
      'running',
      'waiting_input',
      'completed',
      'failed',
      'outcome_unknown',
    ].map((phase, i) => {
      const state = external('dlg-phase-' + i)
      state.runs['dgr-one']!.phase =
        phase as import('../../harness/delegation/types').RunPhase
      return state
    })
    states[2]!.record!.availability = 'needs_recovery'
    const f = fixture(states)
    expect(f.service.list(['root']).agents.map((r) => r.phase)).toEqual([
      'running',
      'waiting',
      'completed',
      'failed',
      'unknown',
    ])
    expect(f.service.list(['root']).agents[2]?.unavailable).toBe(
      'needs_recovery',
    )
    f.sessions.closeAll()
  })
  it('discards malformed external descriptors without breaking readable siblings', () => {
    const broken = external('dlg-broken')
    broken.record = {
      ...broken.record!,
      owner: undefined,
    } as unknown as typeof broken.record
    const f = fixture([broken, external('dlg-ok')])
    expect(f.service.list(['root']).agents.map((r) => r.id)).toEqual(['dlg-ok'])
    f.sessions.closeAll()
  })
  it('invalidates only state/topology and never rescans histories on text output', async () => {
    const state = external('dlg-codex')
    const f = fixture([state])
    const session = child(f, 'sub-child', 'root')
    f.service.list(['root'])
    const readCount = f.snapshotReads.mock.calls.length
    session.subscribe((s, e) => f.service.sessionChanged(s.id, e))
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'hello' },
    })
    f.service.list(['root'])
    await Promise.resolve()
    expect(f.changes).toEqual([])
    expect(f.reads()).toBe(1)
    expect(f.snapshotReads.mock.calls.length).toBe(readCount)
    f.live.set(session.id, {
      id: session.id,
      parentId: 'root',
      description: 'Exact internal task',
      mode: 'spawn',
      depth: 1,
      createdAt: 10,
      status: 'running',
    })
    session.append('turn/start', { turn: 1 })
    await Promise.resolve()
    expect(
      f.service.list(['root']).agents.find((r) => r.id === session.id)?.phase,
    ).toBe('running')
    expect(f.changes).toEqual([{ rootSessionId: 'root', revision: 1 }])
    f.service.externalChanged(state)
    await Promise.resolve()
    expect(f.changes).toHaveLength(1)
    f.sessions.closeAll()
  })
  it('an external run interrupted by a restart reads 已中断, and one without an outcome offers the exit (AGT-04)', () => {
    const interrupted = external('dlg-interrupted'),
      stuck = external('dlg-stuck')
    interrupted.runs['dgr-one']!.phase = 'interrupted'
    stuck.runs['dgr-one']!.phase = 'outcome_unknown'
    stuck.record!.availability = 'needs_recovery'
    const f = fixture([interrupted, stuck])
    const rows = f.service.list(['root']).agents
    const a = rows.find((r) => r.id === 'dlg-interrupted')!,
      b = rows.find((r) => r.id === 'dlg-stuck')!
    expect(a.phase).toBe('interrupted')
    expect(agentPhaseLabel(a.phase)).toBe('已中断')
    expect(a.needsExit).toBeUndefined()
    expect(b).toMatchObject({ phase: 'unknown', needsExit: true })
    f.sessions.closeAll()
  })
})
