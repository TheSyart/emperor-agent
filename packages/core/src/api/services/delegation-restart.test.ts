/**
 * AGT-04 at the Core API: a restart reconciles external runs without opening
 * historical root conversations, and a run left without an outcome gets a
 * "mark as ended" exit.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { makeApi } from '../test-helpers'
import { DelegationJournal } from '../../harness/delegation/journal'
import {
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from '../../harness/delegation/testing'
import type { DelegationRecord } from '../../harness/delegation/types'
import { ClaudeCodeHooks } from '../../harness/hooks/claude-code'

afterEach(() => {
  vi.restoreAllMocks()
})

async function historicalDelegation(
  delegationsRoot: string,
  id: string,
  root: string,
  end: 'completed' | 'running' | 'outcome_unknown',
): Promise<DelegationRecord> {
  const record: DelegationRecord = {
      ...fixtureDelegationRecord(),
      id,
      owner: {
        ...fixtureDelegationRecord().owner,
        rootSessionId: root,
        parentAgentId: root,
      },
      cwd: delegationsRoot,
      workspaceLeaseId: '',
    },
    journal = new DelegationJournal(delegationsRoot, id)
  await journal.append({ type: 'created', record })
  await journal.append({
    type: 'run-created',
    run: { ...fixtureDelegationRun(), delegationId: id },
  })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: { phase: 'preparing', startedAt: 1 },
  })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: { phase: 'running' },
  })
  if (end !== 'running')
    await journal.append({
      type: 'run-changed',
      runId: 'dgr-1',
      patch: {
        phase: end,
        quiescent: end === 'completed',
        finishedAt: 2,
        ...(end === 'outcome_unknown' ? { failureCode: 'OUTPUT_LIMIT' } : {}),
      },
    })
  return record
}

it('startup does not open historical root conversations or run their SessionStart hooks', async () => {
  const first = await makeApi()
  const root = String(first.api.sessions.create({ title: 'old work' }).id)
  // A real conversation with a log on disk.
  first.api.host.agentFor(root)
  const delegationsRoot = first.api.paths.delegationsRoot
  await first.api.close()
  await historicalDelegation(delegationsRoot, 'dlg-settled', root, 'completed')
  await historicalDelegation(delegationsRoot, 'dlg-crashed', root, 'running')
  const started = vi.spyOn(ClaudeCodeHooks.prototype, 'sessionStarted')
  const second = await makeApi({ root: first.root, stateRoot: first.stateRoot })
  try {
    expect(
      started.mock.calls.filter(([agent]) => agent.id === root),
    ).toHaveLength(0)
    expect(
      second.api.delegationRuntime.inspect('dlg-crashed').runs['dgr-1'],
    ).toMatchObject({ phase: 'interrupted', failureCode: 'APP_RESTARTED' })
    // The root's own log still records the new state for its timeline.
    const projections = (second.api.host.sessionLog(root)?.events ?? []).filter(
      (event) => event.type === 'delegation/projection',
    )
    expect(JSON.stringify(projections)).toContain('interrupted')
  } finally {
    await second.api.close()
  }
})
