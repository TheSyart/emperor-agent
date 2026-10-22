import { describe, expect, it } from 'vitest'
import { DelegationJournal } from '../../harness/delegation/journal'
import {
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from '../../harness/delegation/testing'
import { makeApi } from '../test-helpers'
import { invokeCoreOperation, CORE_OPERATION_REGISTRY } from '../operations'

describe('agents.list Core boundary', () => {
  it('keeps the root active, preserves sessions.children and reconstructs native children after restart', async () => {
    const f = await makeApi({ replies: [{ text: 'finished' }] })
    let closed = false
    try {
      const id = String(f.api.sessions.create({ title: 'root' }).id)
      const root = f.api.host.agentFor(id)
      f.api.sessions.activate(id)
      const child = f.api.host.subagents.start(root, {
        description: 'verbatim native task',
        prompt: 'finish',
        mode: 'spawn',
        background: false,
        callId: 'native-call',
      })
      await f.api.host.subagents.waitForSettlement(
        child.id,
        new AbortController().signal,
      )
      await child.whenIdle()
      const listed = await invokeCoreOperation(f.api, 'agents.list', [
        { rootSessionIds: [id] },
      ])
      expect(listed).toMatchObject({
        agents: [
          {
            id: child.id,
            rootSessionId: id,
            parentAgentId: id,
            title: 'verbatim native task',
            phase: 'completed',
            parentCallId: 'native-call',
          },
        ],
      })
      // The UI still shows the root (KRN-01: only activateSession moves it).
      const boot = await f.api.bootstrap()
      expect(
        boot.runtime.events.every((event) => event.session_id === id),
      ).toBe(true)
      expect(f.api.sessions.children({ sessionId: id })[0]?.subagentId).toBe(
        child.id,
      )
      expect(f.events.filter((e) => e.event === 'agent_tree_changed')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rootSessionId: id,
            revision: expect.any(Number),
          }),
        ]),
      )
      await f.api.close()
      closed = true
      const restarted = await makeApi({ root: f.root, stateRoot: f.stateRoot })
      try {
        expect(
          restarted.api.agents.list({ rootSessionIds: [id] }),
        ).toMatchObject(listed)
        restarted.api.host.kept.sessionStore.archive(id)
        expect(
          restarted.api.agents.list({ rootSessionIds: [id] }),
        ).toMatchObject(listed)
        expect(() =>
          restarted.api.agents.list({ rootSessionIds: [child.id] }),
        ).toThrow()
        expect(() =>
          restarted.api.agents.list({ rootSessionIds: ['dlg-foreign'] }),
        ).toThrow()
      } finally {
        await restarted.api.close()
      }
    } finally {
      if (!closed) await f.api.close()
    }
  })
  it('preserves structured-output validation failure when rebuilding without the live manager', async () => {
    const f = await makeApi({
      replies: [{ text: 'completed without the required result' }],
    })
    let closed = false
    try {
      const rootId = String(
        f.api.sessions.create({ title: 'structured parent' }).id,
      )
      const child = f.api.host.subagents.start(f.api.host.agentFor(rootId), {
        description: 'return a structured result',
        prompt: 'finish',
        mode: 'spawn',
        background: false,
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
          required: ['result'],
        },
      })
      const settled = await f.api.host.subagents.waitForSettlement(
        child.id,
        new AbortController().signal,
      )
      await child.whenIdle()
      expect(child.session.lastOf('turn/end')?.data.reason.kind).toBe(
        'completed',
      )
      expect(settled.stopReason).toBe('error')
      const before = f.api.agents
        .list({ rootSessionIds: [rootId] })
        .agents.find((row) => row.id === child.id)
      expect(before).toMatchObject({ phase: 'failed', stopReason: 'error' })
      const settlementFact = f.api.host.sessions
        .get(rootId)
        ?.lastOf('subagent/settled')?.data
      const turnEndSeq = child.session.lastOf('turn/end')?.seq
      await f.api.close()
      closed = true
      const restarted = await makeApi({ root: f.root, stateRoot: f.stateRoot })
      try {
        expect(restarted.api.host.subagents.record(child.id)).toBeUndefined()
        expect(
          restarted.api.agents
            .list({ rootSessionIds: [rootId] })
            .agents.find((row) => row.id === child.id),
        ).toMatchObject({ phase: 'failed', stopReason: 'error' })
        expect(settlementFact).toMatchObject({ childTurnEndSeq: turnEndSeq })
      } finally {
        await restarted.api.close()
      }
    } finally {
      if (!closed) await f.api.close()
    }
  })
  it('rebuilds a durable external conversation after restart without activating a dlg as a native session', async () => {
    const f = await makeApi()
    const rootId = String(f.api.sessions.create({ title: 'external owner' }).id)
    const rootPath = f.api.paths.delegationsRoot
    await f.api.close()
    const record = fixtureDelegationRecord()
    record.owner = {
      ...record.owner,
      rootSessionId: rootId,
      parentAgentId: rootId,
    }
    const journal = new DelegationJournal(rootPath, record.id)
    await journal.append({ type: 'created', record })
    await journal.append({ type: 'run-created', run: fixtureDelegationRun() })
    for (const phase of ['preparing', 'running', 'completed'] as const)
      await journal.append({
        type: 'run-changed',
        runId: 'dgr-1',
        patch: { phase, finishedAt: phase === 'completed' ? 25 : undefined },
      })
    const restarted = await makeApi({ root: f.root, stateRoot: f.stateRoot })
    try {
      const listed = restarted.api.agents.list({ rootSessionIds: [rootId] })
      expect(listed.agents).toEqual([
        expect.objectContaining({
          id: 'dlg-test',
          rootSessionId: rootId,
          parentAgentId: rootId,
          kind: 'external',
          backend: 'codex',
          title: 'Codex 子智能体',
          phase: 'completed',
          currentRunId: 'dgr-1',
          unavailable: 'needs_recovery',
        }),
      ])
      expect(restarted.api.host.sessions.has('dlg-test')).toBe(false)
    } finally {
      await restarted.api.close()
    }
  })
  it('rejects invalid root inputs and preserves unreadable-root errors', async () => {
    const f = await makeApi()
    try {
      expect(() =>
        CORE_OPERATION_REGISTRY['agents.list'].args.parse([
          { rootSessionIds: [''] },
        ]),
      ).toThrow()
      expect(() => f.api.agents.list({ rootSessionIds: ['missing'] })).toThrow()
      expect(f.api.agents.list({ rootSessionIds: [] })).toEqual({ agents: [] })
    } finally {
      await f.api.close()
    }
  })
})
