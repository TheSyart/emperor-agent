import { expect, it, vi } from 'vitest'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { makeApi } from '../test-helpers'
import {
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from '../../harness/delegation/testing'
import type { DelegationState } from '../../harness/delegation/fold'
import { SessionProjector } from '../../harness/projection/projector'
async function fixture(
  replies?: import('../../harness/testing').ScriptedReply[],
) {
  const f = await makeApi({ replies }),
    root = String(f.api.sessions.create({ title: 'external' }).id)
  f.api.sessions.activate(root)
  const record = {
    ...fixtureDelegationRecord(),
    owner: {
      ...fixtureDelegationRecord().owner,
      rootSessionId: root,
      parentAgentId: root,
    },
  }
  const run = {
    ...fixtureDelegationRun(),
    delegationId: record.id,
    phase: 'completed' as const,
    quiescent: true,
    summary: 'done',
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
  vi.spyOn(f.api.delegationRuntime, 'list').mockImplementation(() => [state])
  vi.spyOn(f.api.delegationRuntime, 'inspect').mockImplementation(() =>
    structuredClone(state),
  )
  return { ...f, root, record, run, state }
}
it('exposes one terminal task per external run and keeps old rows terminal on followup', async () => {
  const f = await fixture()
  try {
    expect(f.api.tasks.list({ sessionId: f.root })).toEqual([
      expect.objectContaining({
        kind: 'external-agent',
        id: f.run.id,
        delegation_id: f.record.id,
        status: 'completed',
        acceptance: 'unverified',
      }),
    ])
    const next = { ...f.run, id: 'dgr-next', phase: 'running' as const }
    f.state.runs[next.id] = next
    f.record.currentRunId = next.id
    expect(f.api.tasks.get(f.run.id)?.status).toBe('completed')
    expect(f.api.tasks.list({ sessionId: f.root })).toHaveLength(2)
    expect(await f.api.tasks.wait(f.run.id, { timeoutMs: 5 })).toMatchObject({
      status: 'completed',
    })
  } finally {
    await f.api.close()
  }
})
it('pages external transcript at 500 and readOutput reads its own durable run only', async () => {
  const f = await fixture()
  try {
    const dir = join(
      f.api.paths.delegationsRoot,
      'conversations',
      f.record.id,
      'runs',
    )
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, f.run.id + '.jsonl'),
      Array.from({ length: 505 }, (_, i) =>
        JSON.stringify({
          type: 'text_delta',
          text: 'line ' + i,
          delegationId: f.record.id,
          runId: f.run.id,
          generation: 1,
        }),
      ).join('\n') + '\n',
    )
    expect(f.api.tasks.transcript(f.run.id, { limit: 900 })).toMatchObject({
      total: 505,
      eof: false,
      entries: expect.any(Array),
    })
    expect(
      f.api.tasks.transcript(f.run.id, { limit: 900 }).entries,
    ).toHaveLength(500)
    expect(
      f.api.tasks.transcript(f.run.id, { offset: 500 }).entries,
    ).toHaveLength(5)
    expect((await f.api.tasks.readOutput(f.run.id)).content).toContain(
      'line 504',
    )
  } finally {
    await f.api.close()
  }
})
it('denies cross-root external reads and mutations after switching the active chat', async () => {
  const f = await fixture()
  try {
    const other = f.api.sessions.create({ title: 'another' })
    f.api.sessions.activate(String(other.id))
    expect(() => f.api.delegationService.get({ id: f.record.id })).toThrow(
      'PERMISSION_DENIED',
    )
    expect(() => f.api.tasks.transcript(f.run.id)).toThrow()
    expect(
      f.api.delegationService.get({ id: f.record.id, sessionId: f.root }).record
        ?.id,
    ).toBe(f.record.id)
  } finally {
    await f.api.close()
  }
})
it('replays durable delegation references identically to live projection without internal tool events', async () => {
  const f = await fixture()
  try {
    const session = f.api.host.agentFor(f.root).session
    const before = f.events.length
    session.append('delegation/projection', {
      event: 'delegation_run_changed',
      delegation_id: f.record.id,
      run_id: f.run.id,
      journal_seq: 2,
      task: { id: f.run.id, status: 'completed', acceptance: 'unverified' },
    })
    const live = f.events
      .slice(before)
      .filter((e) => e.event === 'delegation_run_changed')
    const replay = SessionProjector.projectAll(session.events, {
      sessionId: f.root,
    }).filter((e) => e.event === 'delegation_run_changed')
    expect(live).toEqual(replay)
    expect(live).toHaveLength(1)
  } finally {
    await f.api.close()
  }
})

it('reads archived external records with explicit scope but never controls them', async () => {
  const f = await fixture()
  try {
    await f.api.sessions.rename(f.root, { archived: true })
    const other = f.api.sessions.create({ title: 'current' })
    f.api.sessions.activate(String(other.id))
    expect(
      f.api.delegations.get({ id: f.record.id, sessionId: f.root }).record?.id,
    ).toBe(f.record.id)
    expect(f.api.tasks.get(f.run.id, { sessionId: f.root })?.status).toBe(
      'completed',
    )
    expect(f.api.tasks.transcript(f.run.id, { sessionId: f.root }).total).toBe(
      0,
    )
    await expect(
      f.api.delegations.send({
        id: f.record.id,
        sessionId: f.root,
        messageId: 'dgm-no',
        text: 'next',
        delivery: 'queue',
      }),
    ).rejects.toThrow('archived')
  } finally {
    await f.api.close()
  }
})

it('collects real artifacts through Core composition and requires independent criteria before preview and apply', async () => {
  const { delegationRepository, fixtureGit } =
    await import('../../workspace/delegation-test-fixture')
  const { FakeExecutorAdapter } =
    await import('../../harness/delegation/testing')
  const f = delegationRepository(),
    { api, events } = await makeApi()
  try {
    vi.spyOn(
      api as unknown as {
        resolveGitRuntime: (cwd: string) => Promise<{
          executable: string
          gitVersion: string
          env: Record<string, string>
        }>
      },
      'resolveGitRuntime',
    ).mockResolvedValue({
      executable: '/usr/bin/git',
      gitVersion: 'fixture',
      env: { PATH: process.env.PATH ?? '' },
    })
    const root = String(
      api.sessions.create({
        title: 'artifact API',
        mode: 'build',
        project_path: f.repo,
      }).id,
    )
    api.sessions.activate(root)
    api.control.setPermissionMode('workspace-write', root)
    vi.spyOn(api.executorRegistry, 'requireAvailable').mockImplementation(
      async (profile) => ({
        status: 'available',
        checkedAt: Date.now(),
        authVerified: false,
        capabilities: api.executorRegistry.capabilities(profile.backend),
      }),
    )
    const options = (
      api.delegationRuntime as unknown as {
        options: import('../../harness/delegation/service').DelegationServiceOptions
      }
    ).options
    options.runtime = async (_profile, id) => {
      const runtimeRoot = join(api.paths.delegationsRoot, 'test-runtime', id),
        tempRoot = join(runtimeRoot, 'tmp')
      mkdirSync(tempRoot, { recursive: true })
      return {
        runtimeRoot,
        tempRoot,
        environment: { PATH: process.env.PATH ?? '' },
      }
    }
    options.adapters.set(
      'codex',
      new FakeExecutorAdapter('codex', async function* (turn, open) {
        writeFileSync(join(open.cwd, 'src/a.txt'), 'API result')
        writeFileSync(
          join(open.cwd, 'artifact.bin'),
          Buffer.from([0, 255, 128]),
        )
        yield {
          type: 'turn_finished',
          status: 'completed',
          text: 'I say tests passed',
          delegationId: open.delegationId,
          runId: turn.runId,
          generation: open.generation,
        }
      }),
    )
    const config = api.executorConfig.read()
    config.profiles.find((p) => p.backend === 'codex')!.enabled = true
    await api.executors.configure({ expectedRevision: 0, config })
    const owner = {
      ...fixtureDelegationRecord().owner,
      rootSessionId: root,
      parentAgentId: root,
      source: 'human' as const,
    }
    const record = await api.delegationRuntime.start(owner, {
      backend: 'codex',
      description: 'API fixture',
      prompt: 'write files',
      context: 'isolated',
      workspace: 'isolated-worktree',
      base: 'committed',
      runInBackground: false,
      clientRequestId: 'api-loop',
    })
    const run = await api.delegationRuntime.wait(
      record.id,
      record.currentRunId!,
    )
    expect(run).toMatchObject({
      phase: 'completed',
      quiescent: true,
      acceptance: 'unverified',
      receiptId: expect.any(String),
    })
    expect((await api.delegations.collect({ runId: run.id })).id).toBe(
      run.receiptId,
    )
    const receipt = await api.delegations.receipt({ runId: run.id })
    expect(receipt.patch?.content).toContain('diff --git')
    expect(
      api.delegationReceipts.readPatch(run.receiptId!, 32)?.truncated,
    ).toBe(true)
    expect(receipt.receipt?.changedFiles.map((file) => file.path)).toEqual(
      expect.arrayContaining(['src/a.txt', 'artifact.bin']),
    )
    expect(
      events.some(
        (event) =>
          event.event === 'delegation_receipt' && event.run_id === run.id,
      ),
    ).toBe(true)
    await expect(
      api.delegations.integrate({ runId: run.id, action: 'preview' }),
    ).rejects.toThrow('ACCEPTANCE_REQUIRED')
    const accepted = await api.delegations.validate({
      runId: run.id,
      receiptId: run.receiptId!,
      criteria: {
        description: 'independent bytes check',
        commands: [
          {
            executable: process.execPath,
            args: [
              '-e',
              'const f=require("fs");if(f.readFileSync("src/a.txt","utf8")!=="API result"||!f.readFileSync("artifact.bin").equals(Buffer.from([0,255,128])))process.exit(5)',
            ],
          },
        ],
      },
    })
    expect(accepted.state).toBe('passed')
    const preview = await api.delegations.integrate({
      runId: run.id,
      action: 'preview',
    })
    expect(preview).toMatchObject({ status: 'ready', revision: 1 })
    expect((await api.delegations.receipt({ runId: run.id })).preview?.id).toBe(
      preview.id,
    )
    if (!('digest' in preview)) throw new Error('expected preview')
    const head = fixtureGit(f.repo, 'rev-parse', 'HEAD')
    expect(
      await api.delegations.integrate({
        runId: run.id,
        action: 'apply',
        previewId: preview.id,
        expectedRevision: preview.revision,
        previewDigest: preview.digest,
      }),
    ).toMatchObject({ status: 'applied' })
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe('API result')
    expect(fixtureGit(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    const cancelled = api.delegations.validate({
      runId: run.id,
      receiptId: run.receiptId!,
      criteria: {
        description: 'stop a live verifier',
        commands: [
          {
            executable: process.execPath,
            args: [
              '-e',
              'setTimeout(()=>require("fs").writeFileSync("late-verifier-write","bad"),2000);setTimeout(()=>{},20000)',
            ],
          },
        ],
      },
    })
    await vi.waitFor(() =>
      expect(
        readdirSync(join(api.paths.delegationsRoot, 'processes')).some(
          (name) => {
            const ownership = JSON.parse(
              readFileSync(
                join(api.paths.delegationsRoot, 'processes', name),
                'utf8',
              ),
            )
            return (
              ownership.purpose === 'verification' &&
              ownership.parentRunId === run.id &&
              ownership.pid &&
              !ownership.exit
            )
          },
        ),
      ).toBe(true),
    )
    api.control.setPermissionMode('read-only', root)
    expect((await cancelled).state).not.toBe('passed')
    expect(api.delegationAcceptance.isActive(run.id)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(existsSync(join(receipt.receipt!.cwd, 'late-verifier-write'))).toBe(
      false,
    )
    const live = events.filter(
      (event) =>
        event.session_id === root &&
        String(event.event).startsWith('delegation_'),
    )
    const replay = api.runtime
      .replay({ sessionId: root })
      .events.filter((event) => String(event.event).startsWith('delegation_'))
    expect(replay).toEqual(live)
  } finally {
    await api.close()
    rmSync(f.root, { recursive: true, force: true })
  }
}, 45000)

it('lists internal, external, job and workflow tasks together under one root', async () => {
  const f = await fixture([
    {
      tools: [
        {
          id: 'job',
          name: 'bash',
          args: {
            command: 'sleep 30',
            run_in_background: true,
            description: 'retained job',
          },
        },
      ],
    },
    { text: 'job started' },
    {
      tools: [
        {
          id: 'child',
          name: 'subagent',
          args: {
            description: 'internal child',
            prompt: 'internal work',
            run_in_background: false,
          },
        },
      ],
    },
    { text: 'child result' },
    { text: 'child collected' },
    {
      tools: [
        {
          id: 'flow',
          name: 'workflow',
          args: {
            meta: { name: 'mixed', description: 'one stage' },
            script: 'return await agent("stage work", {label:"stage"})',
          },
        },
      ],
    },
    { text: 'stage result' },
    { text: 'flow collected' },
  ])
  try {
    for (const content of ['background job', 'internal child', 'workflow'])
      await f.api.chat.submit({ sessionId: f.root, content })
    expect(
      new Set(f.api.tasks.list({ sessionId: f.root }).map((task) => task.kind)),
    ).toEqual(new Set(['external-agent', 'job', 'subagent', 'workflow']))
  } finally {
    await f.api.close()
  }
})
it('scopes verification recovery to the owning external run', async () => {
  const f = await fixture()
  try {
    vi.spyOn(
      f.api.delegationAcceptance,
      'pendingRecoveries',
    ).mockImplementation((runId) =>
      runId === f.run.id ? ['dgr-verification-123'] : [],
    )
    const recover = vi
      .spyOn(f.api.delegationAcceptance, 'recoverVerification')
      .mockResolvedValue()
    await expect(
      f.api.delegations.recover({
        id: f.record.id,
        expectedRevision: 1,
        verificationId: 'dgr-verification-another',
      }),
    ).rejects.toThrow('PERMISSION_DENIED')
    expect(recover).not.toHaveBeenCalled()
    await f.api.delegations.recover({
      id: f.record.id,
      expectedRevision: 1,
      verificationId: 'dgr-verification-123',
    })
    expect(recover).toHaveBeenCalledWith('dgr-verification-123')
  } finally {
    await f.api.close()
  }
})
