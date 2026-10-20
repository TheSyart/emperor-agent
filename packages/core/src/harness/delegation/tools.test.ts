import { expect, it, vi } from 'vitest'
import { Agent } from '../agent/agent'
import { createTestHarness, replyChunks } from '../testing'
import { SubagentManager } from '../subagent/manager'
import { SandboxPolicyService } from '../sandbox/policy'
import { ApprovalService } from '../approval/service'
import {
  createDelegationTools,
  type DelegationToolOptions,
  type DelegationToolService,
} from './tools'
import { fixture as serviceFixture } from './service-test-fixture'
import { fixtureDelegationRecord, fixtureDelegationRun } from './testing'
import { DelegationError, type DelegationRunRecord } from './types'
function fixture(
  externalService?: DelegationToolService,
  approve?: DelegationToolOptions['approve'],
) {
  const h = createTestHarness(),
    agents = new Map<string, Agent>()
  const manager = new SubagentManager({
    sessions: h.sessions,
    lookupAgent: (id) => agents.get(id),
    createAgent: (session, options) => {
      const agent = new Agent(
        session,
        {
          llm: h.llm,
          tools: h.tools,
          prompt: h.prompt,
          middleware: h.middleware,
        },
        options,
      )
      agents.set(agent.id, agent)
      return agent
    },
    sandbox: new SandboxPolicyService({
      defaultMode: 'read-only',
      workspaceRoot: '/fixture',
    }),
    approval: new ApprovalService('never'),
  })
  const root = h.agent('root')
  agents.set(root.id, root)
  const record = { ...fixtureDelegationRecord(), currentRunId: 'dgr-1' },
    run: DelegationRunRecord = {
      ...fixtureDelegationRun(),
      phase: 'completed',
      summary: 'external result',
    }
  const state = {
    record,
    runs: { 'dgr-1': run },
    messages: {},
    interactions: {},
    outbox: {},
    lastSeq: 1,
  }
  const service: DelegationToolService = {
    start: vi.fn(async () => record),
    inspect: vi.fn(() => state),
    list: vi.fn(() => [state]),
    send: vi.fn(async (_id, input) => ({
      messageId: input.messageId,
      state: 'queued' as const,
    })),
    interrupt: vi.fn(async () => ({ requested: true })),
    wait: vi.fn(async () => run),
    abandon: vi.fn(async () => record),
  }
  for (const tool of createDelegationTools({
    internalManager: manager,
    delegations: () => externalService ?? service,
    ownerResolver: (agent, callId) => ({
      ...record.owner,
      parentAgentId: agent.id,
      parentCallId: callId,
    }),
    canControl: (agent, owner) => agent.id === owner.parentAgentId,
    parentReadOnly: () => true,
    ...(approve ? { approve } : {}),
  }))
    h.tools.register(tool)
  return {
    h,
    root,
    manager,
    service,
    state,
    call: (name: string, args: unknown, agent = root) =>
      h.tools.execute({
        name,
        arguments: args,
        agent,
        callId: 'call-' + name,
        signal: new AbortController().signal,
      }),
  }
}
it('legacy default and fork still use internal manager and never create external journal', async () => {
  const f = fixture()
  f.h.adapter.push(replyChunks({ text: 'internal child' }))
  f.h.adapter.push(replyChunks({ text: 'parent received child notice' }))
  const result = await f.call('subagent', {
    description: 'legacy',
    prompt: 'legacy prompt',
  })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.meta)).toContain('sub-')
  expect(f.service.start).not.toHaveBeenCalled()
  await f.manager
    .get((result.meta as { subagentId: string }).subagentId)
    ?.whenIdle()
  await f.root.whenIdle()
  const listed = await f.call('list_agents', {})
  expect(JSON.stringify(listed.meta)).toContain('sub-')
  expect(JSON.stringify(listed.meta)).toContain('dlg-test')
})
it('foreground external cancellation reaches the exact child run and returns an error', async () => {
  const f = fixture(),
    controller = new AbortController()
  let settle!: (run: ReturnType<typeof fixtureDelegationRun>) => void
  const waiting = new Promise<ReturnType<typeof fixtureDelegationRun>>(
    (resolve) => {
      settle = resolve
    },
  )
  vi.mocked(f.service.wait).mockImplementation(async () => waiting)
  vi.mocked(f.service.interrupt).mockImplementation(async () => {
    settle({ ...fixtureDelegationRun(), phase: 'cancelled' })
    return { requested: true }
  })
  const run = f.h.tools.execute({
    name: 'subagent',
    arguments: {
      backend: 'codex',
      description: 'wait',
      prompt: 'work',
      run_in_background: false,
    },
    agent: f.root,
    callId: 'foreground-call',
    signal: controller.signal,
  })
  await vi.waitFor(() => expect(f.service.wait).toHaveBeenCalled())
  controller.abort()
  expect((await run).isError).toBe(true)
  expect(f.service.interrupt).toHaveBeenCalledWith('dlg-test', 'dgr-1')
})
/** A wait that only ends when its signal aborts (the run never settles). */
function waitUntilAborted(
  _id: string,
  _runId: string,
  signal?: AbortSignal,
): Promise<DelegationRunRecord> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DelegationError('ABORTED', 'wait cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
it('collect_agent stops waiting within a second when the turn is stopped (AGT-09 5)', async () => {
  const f = fixture(),
    controller = new AbortController()
  f.state.runs['dgr-1'] = { ...f.state.runs['dgr-1']!, phase: 'running' }
  vi.mocked(f.service.wait).mockImplementation(waitUntilAborted)
  const collected = f.h.tools.execute({
    name: 'collect_agent',
    arguments: { agent_id: 'dlg-test' },
    agent: f.root,
    callId: 'collect-call',
    signal: controller.signal,
  })
  await vi.waitFor(() => expect(f.service.wait).toHaveBeenCalled())
  const stoppedAt = Date.now()
  controller.abort()
  const result = await collected
  expect(Date.now() - stoppedAt).toBeLessThan(1000)
  expect(result.isError).toBe(true)
  expect(f.service.wait).toHaveBeenCalledWith(
    'dlg-test',
    'dgr-1',
    controller.signal,
  )
})
it('a foreground external wait ends when the turn is stopped, before the run settles (AGT-09 5)', async () => {
  const f = fixture(),
    controller = new AbortController()
  vi.mocked(f.service.wait).mockImplementation(waitUntilAborted)
  const run = f.h.tools.execute({
    name: 'subagent',
    arguments: {
      backend: 'codex',
      description: 'wait',
      prompt: 'work',
      run_in_background: false,
    },
    agent: f.root,
    callId: 'foreground-stop',
    signal: controller.signal,
  })
  await vi.waitFor(() => expect(f.service.wait).toHaveBeenCalled())
  const stoppedAt = Date.now()
  controller.abort()
  expect((await run).isError).toBe(true)
  expect(Date.now() - stoppedAt).toBeLessThan(1000)
  expect(f.service.wait).toHaveBeenCalledWith(
    'dlg-test',
    'dgr-1',
    controller.signal,
  )
  // The run itself is still asked to stop.
  expect(f.service.interrupt).toHaveBeenCalledWith('dlg-test', 'dgr-1')
})
it('external backend resolves trusted owner and profile; queue returns original delegation', async () => {
  const f = fixture()
  const start = await f.call('subagent', {
    backend: 'codex',
    profile_id: 'codex-default',
    description: 'work',
    prompt: 'implement',
  })
  expect(start.isError).toBe(false)
  expect(f.service.start).toHaveBeenCalledWith(
    expect.objectContaining({ parentAgentId: 'root', rootSessionId: 'root' }),
    expect.objectContaining({
      backend: 'codex',
      profileId: 'codex-default',
      workspace: 'shared-readonly',
    }),
  )
  const sent = await f.call('send_message', {
    subagent_id: 'dlg-test',
    message: 'continue',
  })
  expect(sent.isError).toBe(false)
  expect(f.service.send).toHaveBeenCalledWith(
    'dlg-test',
    expect.objectContaining({ text: 'continue', delivery: 'queue' }),
  )
})
it('external fork fails explicitly before any external call', async () => {
  const f = fixture()
  const fork = await f.call('subagent_fork', {
    backend: 'claude-code',
    description: 'fork',
    prompt: 'work',
  })
  expect(JSON.stringify(fork)).toContain('UNSUPPORTED_CONTEXT_MODE')
  expect(f.service.start).not.toHaveBeenCalled()
})
it('when the user does not allow the external executor, the task runs as a local subagent', async () => {
  const f = fixture()
  vi.mocked(f.service.start).mockRejectedValueOnce(
    new DelegationError('EXECUTOR_CONSENT_DENIED', 'the user said no'),
  )
  f.h.adapter.push(replyChunks({ text: 'local child done' }))
  f.h.adapter.push(replyChunks({ text: 'parent saw it' }))
  const result = await f.call('subagent', {
    backend: 'codex',
    description: 'review parser',
    prompt: 'review parser.ts',
  })
  expect(result.isError).toBe(false)
  const meta = result.meta as {
    subagentId: string
    requestedBackend: string
    consent: string
  }
  expect(meta.subagentId).toMatch(/^sub-/)
  expect(meta).toMatchObject({ requestedBackend: 'codex', consent: 'denied' })
  expect(JSON.stringify(result.content)).toMatch(/did not allow Codex/)
  await f.manager.get(meta.subagentId)?.whenIdle()
  await f.root.whenIdle()
})
it('cross-owner control is denied and list exposes only held descendants', async () => {
  const f = fixture()
  const foreign = f.h.agent('foreign')
  const sent = await f.call(
    'send_message',
    { subagent_id: 'dlg-test', message: 'inject' },
    foreign,
  )
  expect(JSON.stringify(sent)).toContain('PERMISSION_DENIED')
  expect(f.service.send).not.toHaveBeenCalled()
  const list = await f.call('list_agents', {})
  expect(JSON.stringify(list.meta)).toContain('dlg-test')
  const hidden = await f.call('list_agents', {}, foreign)
  expect(JSON.stringify(hidden.meta)).not.toContain('dlg-test')
})
it('collect exposes execution and acceptance separately and unknown IDs are rejected', async () => {
  const f = fixture()
  const collected = await f.call('collect_agent', {
    agent_id: 'dlg-test',
    expected_run_id: 'dgr-1',
  })
  expect(collected.isError).toBe(false)
  expect(JSON.stringify(collected.meta)).toContain('unverified')
  expect(
    JSON.stringify(await f.call('inspect_agent', { agent_id: 'other-task' })),
  ).toContain('INVALID_ID')
})
it('describes external dispatch under backend: consent first, file checks at delivery, no blanket acceptance', () => {
  const f = fixture()
  const start = f.h.tools.get('subagent')!
  const backend = JSON.stringify(
    (start.parameters as { properties: Record<string, unknown> }).properties
      .backend,
  )
  expect(backend).not.toContain(
    'Completed execution still requires artifact acceptance',
  )
  expect(backend).toContain('asks the user once')
  expect(f.h.tools.get('collect_agent')!.description).toContain('delivery')
})
it('foreground and collect expose host identities and current workspace in model-visible content', async () => {
  const f = fixture()
  for (const result of [
    await f.call('subagent', {
      backend: 'codex',
      description: 'work',
      prompt: 'work',
      run_in_background: false,
    }),
    await f.call('collect_agent', { agent_id: 'dlg-test' }),
  ]) {
    expect(JSON.stringify(result.content)).toContain('/fixture')
    expect(JSON.stringify(result.content)).toContain('dlg-test')
    expect(JSON.stringify(result.content)).toContain('unverified')
  }
})

it('dispatches one task envelope through the real tool and service and formats continued turns', async () => {
  const runtime = serviceFixture(),
    f = fixture(runtime.service)
  try {
    const result = await f.call('subagent', {
      backend: 'codex',
      description: 'Review parser',
      prompt: 'Inspect parser.ts',
      workspace: 'shared-readonly',
    })
    expect(result.isError).toBe(false)
    const meta = result.meta as { subagentId: string; runId: string }
    await runtime.service.wait(meta.subagentId, meta.runId)
    expect(runtime.adapter.submitted[0]!.text).toBe(
      'Task: Review parser\n\nInspect parser.ts',
    )
    await runtime.service.send(meta.subagentId, {
      messageId: 'followup-envelope',
      text: 'Inspect tests too',
      delivery: 'queue',
    })
    await vi.waitFor(() => expect(runtime.adapter.submitted).toHaveLength(2))
    // A follow-up is a new instruction: it is delivered as written.
    expect(runtime.adapter.submitted[1]!.text).toBe('Inspect tests too')
  } finally {
    await runtime.service.shutdown()
    runtime.cleanup()
  }
})

it('collect_agent ends a run that has no outcome only after the user approves', async () => {
  const approve = vi.fn<NonNullable<DelegationToolOptions['approve']>>(
    async () => 'rejected',
  )
  const f = fixture(undefined, approve)
  f.state.runs['dgr-1']!.phase = 'outcome_unknown'
  f.state.record.availability = 'needs_recovery'
  const refused = await f.call('collect_agent', {
    agent_id: 'dlg-test',
    abandon: true,
  })
  expect(refused.isError).toBe(true)
  expect(JSON.stringify(refused.content)).toContain('APPROVAL_REJECTED')
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: f.root,
      callId: 'call-collect_agent',
      reason: expect.stringContaining('dlg-test'),
    }),
  )
  expect(f.service.abandon).not.toHaveBeenCalled()
  approve.mockResolvedValueOnce('allowed-once')
  vi.mocked(f.service.abandon!).mockImplementationOnce(async () => {
    f.state.runs['dgr-1']!.recoveryResolved = true
    f.state.runs['dgr-1']!.abandoned = { by: 'model', at: 1 }
    f.state.record.availability = 'idle'
    return f.state.record
  })
  const ended = await f.call('collect_agent', {
    agent_id: 'dlg-test',
    abandon: true,
  })
  expect(ended.isError).toBe(false)
  expect(f.service.abandon).toHaveBeenCalledWith('dlg-test', 'model')
  expect(ended.meta).toMatchObject({ abandoned: true })
})
it('collect_agent does not ask to end a run that settled normally', async () => {
  const approve = vi.fn<NonNullable<DelegationToolOptions['approve']>>(
    async () => 'allowed-once',
  )
  const f = fixture(undefined, approve)
  const result = await f.call('collect_agent', {
    agent_id: 'dlg-test',
    abandon: true,
  })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('NOTHING_TO_END')
  expect(approve).not.toHaveBeenCalled()
})
it('7 · collect_agent applies a result only after the user approves on the approval card', async () => {
  const approve = vi.fn<NonNullable<DelegationToolOptions['approve']>>(
    async () => 'rejected',
  )
  const f = fixture(undefined, approve)
  f.state.runs['dgr-1']!.result = {
    base: 'b'.repeat(40),
    commit: 'c'.repeat(40),
    files: [
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
      { path: 'src/b.ts', status: 'added', additions: 2, deletions: 0 },
    ],
    totals: { files: 2, additions: 6, deletions: 1 },
    state: 'ready',
    at: 1,
  }
  f.service.applyResult = vi.fn(async () => ({
    ...f.state.runs['dgr-1']!.result!,
    state: 'applied' as const,
    by: 'model' as const,
  }))
  const refused = await f.call('collect_agent', {
    agent_id: 'dlg-test',
    apply: true,
  })
  expect(refused.isError).toBe(true)
  expect(JSON.stringify(refused.content)).toContain('APPROVAL_REJECTED')
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: f.root,
      callId: 'call-collect_agent',
      reason: expect.stringMatching(/2 files[\s\S]*\+6[\s\S]*−1/),
    }),
  )
  expect(f.service.applyResult).not.toHaveBeenCalled()
  approve.mockResolvedValueOnce('allowed-once')
  const applied = await f.call('collect_agent', {
    agent_id: 'dlg-test',
    apply: true,
  })
  expect(applied.isError).toBe(false)
  expect(f.service.applyResult).toHaveBeenCalledWith(
    'dlg-test',
    'dgr-1',
    'model',
  )
  expect(applied.meta).toMatchObject({ result: { state: 'applied' } })
})
it('collect_agent reports conflicts after an approved apply and leaves the result in place', async () => {
  const approve = vi.fn<NonNullable<DelegationToolOptions['approve']>>(
    async () => 'allowed-once',
  )
  const f = fixture(undefined, approve)
  const result = {
    base: 'b'.repeat(40),
    commit: 'c'.repeat(40),
    files: [
      {
        path: 'src/a.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
      },
    ],
    totals: { files: 1, additions: 1, deletions: 1 },
    state: 'ready' as const,
    at: 1,
  }
  f.state.runs['dgr-1']!.result = result
  f.service.applyResult = vi.fn(async () => ({
    ...result,
    state: 'conflicted' as const,
    conflicts: ['src/a.ts'],
  }))
  const outcome = await f.call('collect_agent', {
    agent_id: 'dlg-test',
    apply: true,
  })
  expect(outcome.isError).toBe(true)
  expect(JSON.stringify(outcome.content)).toContain('src/a.ts')
})
it('collect_agent has nothing to apply for a run without changed files', async () => {
  const approve = vi.fn<NonNullable<DelegationToolOptions['approve']>>(
    async () => 'allowed-once',
  )
  const f = fixture(undefined, approve)
  f.service.applyResult = vi.fn()
  const outcome = await f.call('collect_agent', {
    agent_id: 'dlg-test',
    apply: true,
  })
  expect(outcome.isError).toBe(true)
  expect(JSON.stringify(outcome.content)).toContain('NOTHING_TO_APPLY')
  expect(approve).not.toHaveBeenCalled()
})
it('1 · a write task defaults to a snapshot of the current workspace; a review to the shared folder', async () => {
  const f = fixture()
  // fixture's parent is read-only: a review in place.
  await f.call('subagent', {
    backend: 'codex',
    description: 'review',
    prompt: 'look',
  })
  expect(f.service.start).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      workspace: 'shared-readonly',
      base: 'committed',
    }),
  )
  await f.call('subagent', {
    backend: 'codex',
    description: 'write',
    prompt: 'change',
    workspace: 'isolated-worktree',
  })
  expect(f.service.start).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      workspace: 'isolated-worktree',
      base: 'snapshot',
    }),
  )
})
it('8 · outside Git a task defaults to a read-only review even when the parent may write', async () => {
  const h = createTestHarness()
  const record = { ...fixtureDelegationRecord(), currentRunId: 'dgr-1' }
  const start = vi.fn(async () => record)
  const service = {
    start,
    inspect: vi.fn(),
    list: vi.fn(() => []),
    send: vi.fn(),
    interrupt: vi.fn(),
    wait: vi.fn(),
  } as unknown as DelegationToolService
  for (const inGit of [false, true]) {
    const tools = createDelegationTools({
      internalManager: {} as SubagentManager,
      delegations: () => service,
      ownerResolver: () => record.owner,
      canControl: () => true,
      parentReadOnly: () => false,
      parentInGit: () => inGit,
    })
    const subagent = tools.find((t) => t.name === 'subagent')!
    await subagent.execute(
      subagent.parse({ backend: 'codex', description: 'd', prompt: 'p' }),
      {
        agent: h.agent('root-' + inGit),
        callId: 'call-' + inGit,
        signal: new AbortController().signal,
      } as never,
    )
    expect(start).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspace: inGit ? 'isolated-worktree' : 'shared-readonly',
        base: inGit ? 'snapshot' : 'committed',
      }),
    )
  }
})
