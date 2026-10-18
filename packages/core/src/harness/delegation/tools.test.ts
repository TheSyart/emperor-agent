import { expect, it, vi } from 'vitest'
import { Agent } from '../agent/agent'
import { createTestHarness, replyChunks } from '../testing'
import { SubagentManager } from '../subagent/manager'
import { SandboxPolicyService } from '../sandbox/policy'
import { ApprovalService } from '../approval/service'
import { createDelegationTools, type DelegationToolService } from './tools'
import { fixture as serviceFixture } from './service-test-fixture'
import { fixtureDelegationRecord, fixtureDelegationRun } from './testing'
function fixture(externalService?: DelegationToolService) {
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
    run = {
      ...fixtureDelegationRun(),
      phase: 'completed' as const,
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
  }))
    h.tools.register(tool)
  return {
    h,
    root,
    manager,
    service,
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
it('external fork and provider option fail explicitly before any external call', async () => {
  const f = fixture()
  const fork = await f.call('subagent_fork', {
    backend: 'claude-code',
    description: 'fork',
    prompt: 'work',
  })
  expect(JSON.stringify(fork)).toContain('UNSUPPORTED_CONTEXT_MODE')
  const provider = await f.call('subagent', {
    backend: 'codex',
    provider: 'main-llm',
    description: 'work',
    prompt: 'work',
  })
  expect(JSON.stringify(provider)).toContain('UNSUPPORTED_OPTION')
  expect(f.service.start).not.toHaveBeenCalled()
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
it('describes direct dispatch and defers file checks to delivery instead of requiring acceptance for all tasks', () => {
  const f = fixture()
  const start = f.h.tools.get('subagent')!
  expect(start.description).not.toContain(
    'Completed execution still requires artifact acceptance',
  )
  expect(start.description).toContain('delivery')
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
    expect(runtime.adapter.submitted[1]!.text).toBe(
      'Task: Review parser\n\nInspect tests too',
    )
  } finally {
    await runtime.service.shutdown()
    runtime.cleanup()
  }
})
