// HarnessHost end to end on a temporary Emperor Home with a scripted model:
// a full turn streamed to the UI sink, sandbox escalation through the
// approval interaction, ask_user_question answered from control, plan mode
// review, stop, and replay equal to the live projection.
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import { messageText } from '../../llm/message'
import type { RouteSpec } from '../../llm/route'
import type { GenerateOptions } from '../../llm/types'
import type { SandboxBackend } from '../sandbox/backend'
import {
  replyChunks,
  ScriptedAdapter,
  testRoute,
  type ScriptedReply,
} from '../testing'
import { assertRequestInvariant } from '../agent/invariant'
import { HarnessHost } from './host'

const hosts: HarnessHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

/** Backend that runs commands unconfined (tests cannot rely on a real sandbox). */
const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [],
  }),
}

async function makeHost(
  replies: ScriptedReply[] = [],
  options: { templatesDir?: string; route?: Partial<RouteSpec> } = {},
): Promise<{
  host: HarnessHost
  adapter: ScriptedAdapter
  events: Array<Record<string, unknown>>
}> {
  const root = mkdtempSync(join(tmpdir(), 'harness-host-'))
  const adapter = new ScriptedAdapter(replies)
  const ref: { host?: HarnessHost } = {}
  const llm = new LlmClient({
    adapterFor: () => adapter,
    onRequest: (request) => {
      assertRequestInvariant(request, (id) => ref.host?.sessionLog(id))
    },
  })
  llm.setRoutes([testRoute(options.route)], 'test-route')
  const events: Array<Record<string, unknown>> = []
  const host = await HarnessHost.create({
    root,
    ...(options.templatesDir === undefined
      ? {}
      : { templatesDir: options.templatesDir }),
    stateRoot: join(root, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    sandboxBackend: passthroughBackend,
    initializeMcp: false,
    eventSink: (event) => {
      events.push(event)
    },
  })
  ref.host = host
  hosts.push(host)
  return { host, adapter, events }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The repository's shipped prompt templates (persona.md). */
const REPO_TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'templates',
)

describe('HarnessHost', () => {
  it('keeps the model and working directory out of the system prompt prefix', async () => {
    const one = await makeHost([{ text: 'one' }], {
      templatesDir: REPO_TEMPLATES,
    })
    const two = await makeHost([{ text: 'two' }], {
      templatesDir: REPO_TEMPLATES,
      route: { modelId: 'other-model' },
    })
    const fallback = await makeHost([{ text: 'three' }])
    const requests: GenerateOptions[] = []
    for (const { host, adapter } of [one, two, fallback]) {
      const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
      await host.submit({ sessionId: entry.id, content: 'hi' })
      requests.push(adapter.requests[0]!)
    }
    const [a, b, c] = requests as [
      GenerateOptions,
      GenerateOptions,
      GenerateOptions,
    ]
    const prefix = (request: GenerateOptions) =>
      Buffer.from(request.system ?? '').subarray(0, 200)
    expect(a.system).toMatch(/^You are Emperor Agent/)
    expect(prefix(a).equals(prefix(b))).toBe(true)
    for (const [request, model, host] of [
      [a, 'test-model', one.host],
      [b, 'other-model', two.host],
      [c, 'test-model', fallback.host],
    ] as const) {
      const cwd = host.chatWorkspace()
      expect(request.system).not.toContain(cwd)
      expect(request.system).not.toContain(model)
      // Both facts reach the model through the runtime-context snapshot.
      const context = request.messages.find(
        (message) =>
          message.source.kind === 'context' &&
          message.source.producer === 'runtime-context',
      )
      expect(context && messageText(context)).toContain(JSON.stringify(cwd))
      expect(context && messageText(context)).toContain(model)
    }
  })

  it('runs a turn and streams the projected timeline', async () => {
    const { host, adapter, events } = await makeHost([
      { text: 'Hello from Emperor' },
    ])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    const result = await host.submit({
      sessionId: entry.id,
      content: 'hi',
      clientMessageId: 'c1',
      displayContent: 'hi!',
    })
    expect(result.content).toBe('Hello from Emperor')
    expect(result.turnId).toBe(`${entry.id}:1`)
    const names = events.map((event) => event.event)
    expect(names).toContain('user_message')
    expect(names).toContain('message_delta')
    expect(names).toContain('assistant_done')
    const user = events.find((event) => event.event === 'user_message')!
    expect(user).toMatchObject({
      content: 'hi!',
      client_message_id: 'c1',
      session_id: entry.id,
    })
    const request = adapter.requests[0]!
    expect(request.system).toContain('Emperor Agent')
    expect(request.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'bash',
        'read',
        'write',
        'edit',
        'glob',
        'grep',
        'todo_write',
        'ask_user_question',
        'exit_plan_mode',
        'subagent',
        'skill',
        'memory_edit',
        'job_output',
        'get_goal',
        'mcp_config',
      ]),
    )
    expect(request.system).toContain('use the mcp_config tool')
    expect(request.tools?.map((tool) => tool.name)).not.toContain('report')
    const live = events.filter((event) => Number(event.seq) > 0)
    expect(host.replay(entry.id).events).toEqual(live)
  })

  it('tells the model to link local files, the same text on every turn', async () => {
    const { host, adapter } = await makeHost([{ text: 'one' }, { text: 'two' }])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    await host.submit({ sessionId: entry.id, content: 'a' })
    await host.submit({ sessionId: entry.id, content: 'b' })
    const [first, second] = adapter.requests.map((request) => request.system!)
    expect(first).toContain('[readable name](path)')
    expect(first).toContain('code formatting')
    expect(first!.indexOf('[readable name](path)')).toBeGreaterThan(
      first!.indexOf('Emperor Agent'),
    )
    expect(second).toBe(first)
  })

  it('asks for approval on sandbox escalation and runs once when allowed', async () => {
    const { host, events } = await makeHost()
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    const agent = host.agentFor(entry.id)
    host.setPermissionPreset(entry.id, 'read-only')
    const scripted = [
      {
        tools: [
          {
            id: 'b1',
            name: 'bash',
            args: {
              command: 'echo escalated',
              description: 'print a word',
              sandbox_permissions: 'danger-full-access',
              justification: 'needs to write outside',
            },
          },
        ],
      },
      { text: 'done' },
    ] as ScriptedReply[]
    ;(
      host.llm as unknown as { options: { adapterFor: () => ScriptedAdapter } }
    ).options
      .adapterFor()
      .push(...scripted)
    const submitted = host.submit({ sessionId: entry.id, content: 'run it' })
    await waitFor(() => events.some((event) => event.event === 'ask_request'))
    const ask = events.find((event) => event.event === 'ask_request')!
      .interaction as { id: string; meta: { interaction_type: string } }
    expect(ask.meta.interaction_type).toBe('permission')
    expect(host.controlPayload(entry.id).pending).toMatchObject({ id: ask.id })
    host.answerInteraction(ask.id, {
      permission: { option_id: 'allow_once', choice: '允许本次', freeform: '' },
    })
    await submitted
    const result = agent.session.lastOf('tool/result')!
    expect(JSON.stringify(result.data.message.content)).toContain('escalated')
    expect(events.some((event) => event.event === 'ask_answered')).toBe(true)
    expect(host.controlPayload(entry.id)).toMatchObject({
      preset: 'read-only',
      pending: null,
    })
  })

  it('answers ask_user_question and plan reviews through control', async () => {
    const { host, events } = await makeHost()
    const adapter = (
      host.llm as unknown as { options: { adapterFor: () => ScriptedAdapter } }
    ).options.adapterFor()
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    adapter.push(
      {
        tools: [
          {
            id: 'q1',
            name: 'ask_user_question',
            args: {
              questions: [
                {
                  id: 'color',
                  question: 'Which color?',
                  options: [{ label: 'red' }, { label: 'blue' }],
                },
              ],
            },
          },
        ],
      },
      (request: GenerateOptions) => {
        expect(JSON.stringify(request.messages.at(-1)?.content)).toContain(
          'blue',
        )
        return replyChunks({ text: 'blue it is' })
      },
    )
    const first = host.submit({ sessionId: entry.id, content: 'pick' })
    await waitFor(() => events.some((event) => event.event === 'ask_request'))
    const ask = events.find((event) => event.event === 'ask_request')!
      .interaction as { id: string }
    host.answerInteraction(ask.id, { color: { choice: 'blue', freeform: '' } })
    expect((await first).content).toBe('blue it is')

    host.setPlanMode(entry.id, true)
    adapter.push(
      (request: GenerateOptions) => {
        expect(request.system).toContain('You are in plan mode')
        return replyChunks({
          tools: [
            {
              id: 'p1',
              name: 'exit_plan_mode',
              args: { plan: '# Do the thing\n- step' },
            },
          ],
        })
      },
      { text: 'implementing' },
    )
    const second = host.submit({ sessionId: entry.id, content: 'plan it' })
    await waitFor(() => events.some((event) => event.event === 'plan_draft'))
    const plan = events.find((event) => event.event === 'plan_draft')!
      .interaction as { id: string; plan_markdown: string }
    expect(plan.plan_markdown).toContain('# Do the thing')
    host.approvePlan(plan.id)
    await second
    expect(events.some((event) => event.event === 'plan_approved')).toBe(true)
    expect(host.controlPayload(entry.id).plan).toBe(false)
  })

  it('ends the turn when the user dismisses the plan review, without another model request', async () => {
    const { host, adapter, events } = await makeHost([
      {
        tools: [
          {
            id: 'p1',
            name: 'exit_plan_mode',
            args: { plan: '# Do the thing\n- step' },
          },
        ],
      },
      // Consumed only if the dismissal regresses to another model request.
      { text: 'Waiting for your message.' },
    ])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    host.setPlanMode(entry.id, true)
    const submitted = host.submit({ sessionId: entry.id, content: 'plan it' })
    await waitFor(() => events.some((event) => event.event === 'plan_draft'))
    const plan = events.find((event) => event.event === 'plan_draft')!
      .interaction as { id: string }
    host.cancelInteraction(plan.id)
    await submitted
    expect(adapter.requests).toHaveLength(1)
    const log = host.sessionLog(entry.id)!
    expect(log.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'plan-dismissed',
    })
    const result = log.lastOf('tool/result')!
    expect(result.data.message.content[0]).toMatchObject({
      isError: false,
      content: [
        {
          type: 'text',
          text: 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
        },
      ],
    })
    expect(result.data.meta).toMatchObject({ approved: false, dismissed: true })
    expect(host.controlPayload(entry.id).plan).toBe(true)
    expect(
      events.find((event) => event.event === 'assistant_done'),
    ).toMatchObject({ stop_reason: 'plan-dismissed' })
  })

  it('announces queued prompts entering and leaving the inbox', async () => {
    const { host, events } = await makeHost([{ hang: true }, { text: 'two' }])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    const first = host.submit({ sessionId: entry.id, content: 'one' })
    await waitFor(() => host.isBusy(entry.id))
    const second = host.submit({ sessionId: entry.id, content: 'two' })
    await waitFor(() => events.some((event) => event.event === 'prompt_queued'))
    const queued = host.queuedPrompts(entry.id)
    expect(queued).toHaveLength(1)
    const queuedEvents = events.filter(
      (event) => event.event === 'prompt_queued',
    )
    expect(queuedEvents).toEqual([
      expect.objectContaining({
        session_id: entry.id,
        prompt_id: queued[0]!.prompt_id,
        seq: 0,
      }),
    ])
    expect(
      host.manageQueuedPrompt(entry.id, queued[0]!.prompt_id, 'cancel'),
    ).toBe(true)
    await waitFor(() =>
      events.some((event) => event.event === 'prompt_dequeued'),
    )
    expect(
      events.find((event) => event.event === 'prompt_dequeued'),
    ).toMatchObject({ session_id: entry.id, prompt_id: queued[0]!.prompt_id })
    host.stop(entry.id)
    await Promise.all([first, second])
  })

  it('stops a running turn and cancels pending questions', async () => {
    const { host, events } = await makeHost()
    const adapter = (
      host.llm as unknown as { options: { adapterFor: () => ScriptedAdapter } }
    ).options.adapterFor()
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    adapter.push({
      tools: [
        {
          id: 'q',
          name: 'ask_user_question',
          args: { questions: [{ id: 'a', question: 'ok?' }] },
        },
      ],
    })
    const submitted = host.submit({ sessionId: entry.id, content: 'go' })
    await waitFor(() => events.some((event) => event.event === 'ask_request'))
    expect(host.stop(entry.id)).toBe(true)
    await submitted
    expect(
      events.some((event) => event.event === 'runtime_task_cancelled'),
    ).toBe(true)
    expect(host.controlPayload(entry.id).pending).toBeNull()
  })

  it('loads AGENTS.md and memory as durable context', async () => {
    const { host, adapter } = await makeHost([{ text: 'ok' }])
    writeFileSync(
      host.kept.sharedMemory.memoryFile,
      '# Memory\n- The user likes tea.\n',
    )
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    writeFileSync(
      join(host.chatWorkspace(), 'AGENTS.md'),
      'Always answer briefly.',
    )
    await host.submit({ sessionId: entry.id, content: 'hello' })
    const text = JSON.stringify(adapter.requests[0]!.messages)
    expect(text).toContain('Always answer briefly.')
    expect(text).toContain('The user likes tea.')
  })

  it('serves raw history, lineage, children, and a raw tap for delegated children', async () => {
    const { host } = await makeHost([
      {
        tools: [
          {
            id: 'd1',
            name: 'subagent',
            args: {
              description: 'research',
              prompt: 'find x',
              run_in_background: false,
            },
          },
        ],
      },
      { text: 'child found x' },
      { text: 'parent done' },
    ])
    const tapped: Array<{ sessionId: string; type: string }> = []
    const unsubscribe = host.rawTap((sessionId, event) => {
      tapped.push({ sessionId, type: event.type })
    })
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    await host.submit({ sessionId: entry.id, content: 'delegate' })

    const children = host.children(entry.id)
    expect(children).toHaveLength(1)
    const child = children[0]!
    expect(child).toMatchObject({
      callId: 'd1',
      description: 'research',
      mode: 'spawn',
      background: false,
      status: 'settled',
      stopReason: 'completed',
    })
    // Child sessions stay out of the sidebar index.
    expect(host.kept.sessionStore.get(child.subagentId)).toBeNull()

    expect(host.lineage(child.subagentId)).toEqual({
      chain: [
        { sessionId: entry.id },
        {
          sessionId: child.subagentId,
          description: 'research',
          parentCallId: 'd1',
        },
      ],
    })
    expect(host.lineage(entry.id)).toEqual({
      chain: [{ sessionId: entry.id }],
    })
    expect(host.lineage('missing')).toBeUndefined()

    const rootPage = host.history(entry.id)!
    expect(rootPage.header.id).toBe(entry.id)
    expect(rootPage.hasMore).toBe(false)
    expect(rootPage.lastSeq).toBe(rootPage.events.at(-1)!.seq)
    expect(rootPage.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['subagent/started', 'subagent/settled']),
    )
    const childPage = host.history(child.subagentId)!
    expect(childPage.header).toMatchObject({
      origin: 'subagent',
      parentSession: entry.id,
    })
    expect(
      childPage.events.some((event) => event.type === 'assistant/message'),
    ).toBe(true)
    expect(host.history('missing')).toBeUndefined()

    // Root and child appends both reach the raw tap.
    expect(
      tapped.some(
        (item) =>
          item.sessionId === entry.id && item.type === 'assistant/message',
      ),
    ).toBe(true)
    expect(
      tapped.some(
        (item) =>
          item.sessionId === child.subagentId &&
          item.type === 'assistant/message',
      ),
    ).toBe(true)
    unsubscribe()
    const before = tapped.length
    host.sessionLog(entry.id)!.append('todo/write', { todos: [] })
    expect(tapped).toHaveLength(before)
  })

  it('hides a fork child seed from its history page', async () => {
    const { host } = await makeHost([
      { text: 'first answer' },
      {
        tools: [
          {
            id: 'f1',
            name: 'subagent_fork',
            args: {
              description: 'forked',
              prompt: 'continue',
              run_in_background: false,
            },
          },
        ],
      },
      { text: 'fork child answer' },
      { text: 'parent after fork' },
    ])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    await host.submit({ sessionId: entry.id, content: 'first' })
    await host.submit({ sessionId: entry.id, content: 'fork now' })
    const child = host.children(entry.id)[0]!
    expect(child.mode).toBe('fork')
    const log = host.sessionLog(child.subagentId)!
    expect(log.header.seedLength).toBeGreaterThan(0)
    const page = host.history(child.subagentId)!
    expect(
      page.events.every((event) => event.seq > log.header.seedLength!),
    ).toBe(true)
    expect(JSON.stringify(page.events)).not.toContain('first answer')
    expect(JSON.stringify(page.events)).toContain('fork child answer')
  })

  it('tells the UI when opening a session repaired its log', async () => {
    const { host, events } = await makeHost([{ text: 'ok' }])
    const entry = host.kept.sessionStore.create('t', { mode: 'chat' })
    await host.submit({ sessionId: entry.id, content: 'hi' })
    host.sessions.close(entry.id)
    appendFileSync(
      join(host.sessions.root, entry.id, 'log.jsonl'),
      '{"type":"tu',
    )
    expect(host.sessions.open(entry.id).hasOpenTurn()).toBe(false)
    await waitFor(() => events.some((e) => e.event === 'session_log_state'))
    expect(events.find((e) => e.event === 'session_log_state')).toMatchObject({
      session_id: entry.id,
      state: 'repaired',
      kind: 'tail',
      dropped_bytes: 11,
      seq: 0,
    })
  })
})

it('root stop disarms an idle Goal before an external settlement can revive automatic work', async () => {
  const { host, adapter } = await makeHost()
  const entry = host.kept.sessionStore.create('stop fixture', { mode: 'chat' }),
    agent = host.agentFor(entry.id)
  host.goals.create(agent, { objective: 'fixture only' })
  host.stop(entry.id)
  host.goalInstall.driver.delegationSettled(entry.id)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(host.goals.get(agent)?.activation).toBe('disarmed')
  expect(adapter.requests).toHaveLength(0)
})
