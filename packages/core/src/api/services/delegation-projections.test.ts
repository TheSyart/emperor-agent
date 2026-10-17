import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
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
