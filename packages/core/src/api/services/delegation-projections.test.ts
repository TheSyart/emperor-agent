import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { makeApi } from '../test-helpers'
import {
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from '../../harness/delegation/testing'
import type { DelegationState } from '../../harness/delegation/fold'
import type { DelegationProjection } from '../../harness/delegation/events'
import type { CoreApi } from '../core-api'
import { LOG_FILE } from '../../session-log/store'

function publish(api: CoreApi, rootId: string, parentId: string) {
  const record = fixtureDelegationRecord()
  const run = { ...fixtureDelegationRun(), id: 'dgr-test' }
  record.owner = {
    ...record.owner,
    rootSessionId: rootId,
    parentAgentId: parentId,
    parentCallId: 'external-call',
  }
  record.currentRunId = run.id
  const state: DelegationState = {
    record,
    runs: { [run.id]: run },
    messages: {},
    interactions: {},
    outbox: {},
    lastSeq: 2,
  }
  ;(
    api as unknown as {
      appendDelegationProjection(
        state: DelegationState,
        projection: DelegationProjection,
      ): void
    }
  ).appendDelegationProjection(state, {
    event: 'delegation_output',
    delegation_id: record.id,
    run_id: run.id,
    journal_seq: 2,
    output: [{ role: 'assistant', content: 'nested executor output' }],
  })
}

it('stores nested external output on the actual parent and notifies the root once', async () => {
  const f = await makeApi({ replies: [{ text: 'internal child ready' }] })
  try {
    const rootId = String(f.api.sessions.create({ title: 'root' }).id)
    const root = f.api.host.agentFor(rootId)
    const child = f.api.host.subagents.start(root, {
      description: 'internal parent',
      prompt: 'be ready',
      mode: 'spawn',
      background: false,
      callId: 'internal-call',
    })
    await f.api.host.subagents.waitForSettlement(
      child.id,
      new AbortController().signal,
    )
    await child.whenIdle()
    const rawSessionIds: string[] = []
    const untap = f.api.host.rawTap((sessionId, event) => {
      if (event.type === 'delegation/projection') rawSessionIds.push(sessionId)
    })
    try {
      publish(f.api, rootId, child.id)
    } finally {
      untap()
    }
    const nested = child.session.events.filter(
      (event) => event.type === 'delegation/projection',
    )
    expect(nested).toHaveLength(1)
    expect(nested[0]?.data).toMatchObject({
      parent_call_id: 'external-call',
      current_run_id: 'dgr-test',
      backend: 'codex',
      output: [{ role: 'assistant', content: 'nested executor output' }],
    })
    expect(rawSessionIds).toEqual([child.id])
    expect(
      root.session.events.filter(
        (event) => event.type === 'delegation/projection',
      ),
    ).toHaveLength(0)
    expect(
      f.events.filter((event) => event.event === 'delegation_output'),
    ).toEqual([
      expect.objectContaining({
        session_id: rootId,
        run_id: 'dgr-test',
        output: [{ role: 'assistant', content: 'nested executor output' }],
      }),
    ])
    expect(
      readFileSync(join(f.api.paths.sessionsRoot, child.id, LOG_FILE), 'utf8'),
    ).toContain('nested executor output')
    expect(
      f.api.host
        .replay(child.id)
        .events.filter((event) => event.event === 'delegation_output'),
    ).toEqual([
      expect.objectContaining({
        session_id: child.id,
        parent_call_id: 'external-call',
        run_id: 'dgr-test',
      }),
    ])
  } finally {
    await f.api.close()
  }
})

it('projects a root-owned external run once without an extra root notification', async () => {
  const f = await makeApi()
  try {
    const rootId = String(f.api.sessions.create({ title: 'root' }).id)
    const root = f.api.host.agentFor(rootId)
    publish(f.api, rootId, rootId)
    expect(
      root.session.events.filter(
        (event) => event.type === 'delegation/projection',
      ),
    ).toHaveLength(1)
    expect(
      f.events.filter((event) => event.event === 'delegation_output'),
    ).toEqual([
      expect.objectContaining({ session_id: rootId, run_id: 'dgr-test' }),
    ])
  } finally {
    await f.api.close()
  }
})

it('flushes output from cached ownership without rereading every durable delegation journal or changing the tree', async () => {
  const f = await makeApi()
  const original = f.api.delegationRuntime.list.bind(f.api.delegationRuntime)
  try {
    const rootId = String(f.api.sessions.create({ title: 'root' }).id)
    const state: DelegationState = {
      record: {
        ...fixtureDelegationRecord(),
        owner: {
          ...fixtureDelegationRecord().owner,
          rootSessionId: rootId,
          parentAgentId: rootId,
        },
        currentRunId: 'dgr-1',
      },
      runs: { 'dgr-1': { ...fixtureDelegationRun(), phase: 'running' } },
      messages: {},
      interactions: {},
      outbox: {},
      lastSeq: 2,
    }
    const core = f.api as unknown as {
      projectDelegation(
        state: DelegationState,
        event: import('../../harness/delegation/fold').DelegationEvent,
      ): void
      flushDelegationOutput(runId: string): void
    }
    core.projectDelegation(state, { type: 'created', record: state.record! })
    await Promise.resolve()
    const changes = f.events.filter(
      (e) => e.event === 'agent_tree_changed',
    ).length
    const runtime = f.api.delegationRuntime as unknown as {
      options: import('../../harness/delegation/service').DelegationServiceOptions
    }
    runtime.options.onEvent!({
      type: 'text_delta',
      text: 'public output',
      delegationId: 'dlg-test',
      runId: 'dgr-1',
      generation: 1,
    })
    vi.spyOn(f.api.delegationRuntime, 'list').mockImplementation(() => {
      throw new Error('all journal histories were rescanned')
    })
    core.flushDelegationOutput('dgr-1')
    await Promise.resolve()
    expect(
      f.api.host.sessions
        .get(rootId)
        ?.events.filter((e) => e.type === 'delegation/projection')
        .at(-1)?.data,
    ).toMatchObject({
      output: [{ role: 'assistant', content: 'public output' }],
    })
    expect(
      f.events.filter((e) => e.event === 'agent_tree_changed'),
    ).toHaveLength(changes)
  } finally {
    vi.spyOn(f.api.delegationRuntime, 'list').mockImplementation(original)
    await f.api.close()
  }
})
