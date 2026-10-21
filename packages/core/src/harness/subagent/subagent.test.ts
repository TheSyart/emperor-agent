// Delegated subagents: background spawn + settlement notice to the parent,
// foreground wait, fork seeding (completed turns only), fixed permission
// scope, depth limit, send_message, interrupt authority, and report.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { messageText, userText } from '../../llm/message'
import type { GenerateOptions } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import { Agent } from '../agent/agent'
import { ApprovalService } from '../approval/service'
import { SandboxPolicyService } from '../sandbox/policy'
import {
  createTestHarness,
  replyChunks,
  testRoute,
  type TestHarness,
} from '../testing'
import { SubagentManager } from './manager'
import { installSubagents } from './tools'

function setup(
  maxDepth?: number,
  logRoot?: string,
  extra: Partial<ConstructorParameters<typeof SubagentManager>[0]> = {},
): {
  h: TestHarness
  manager: SubagentManager
  agents: Map<string, Agent>
  root: Agent
} {
  const h = createTestHarness(logRoot === undefined ? {} : { root: logRoot })
  const agents = new Map<string, Agent>()
  const sandbox = new SandboxPolicyService({
    defaultMode: 'workspace-write',
    workspaceRoot: '/workspace',
  })
  const approval = new ApprovalService('ask')
  const manager = new SubagentManager({
    sessions: h.sessions,
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
    lookupAgent: (id) => agents.get(id),
    sandbox,
    approval,
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...extra,
  })
  installSubagents(manager, h.tools, h.prompt)
  const root = h.agent('root')
  agents.set(root.id, root)
  return { h, manager, agents, root }
}

async function settleAll(agents: Map<string, Agent>): Promise<void> {
  for (let round = 0; round < 5; round++) {
    for (const agent of agents.values()) await agent.whenIdle()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const textOf = (request: GenerateOptions): string[] =>
  request.messages.map((m) => messageText(m))

/** Push replies routed by session: `root` replies go to the root agent, `child` to any other session. */
function routed(
  h: TestHarness,
  replies: {
    root: Parameters<typeof replyChunks>[0][]
    child: Parameters<typeof replyChunks>[0][]
  },
): void {
  const queues = { root: [...replies.root], child: [...replies.child] }
  const total = queues.root.length + queues.child.length
  for (let index = 0; index < total; index++) {
    h.adapter.push((request: GenerateOptions) => {
      const queue = request.sessionId === 'root' ? queues.root : queues.child
      const next = queue.shift()
      if (next === undefined)
        throw new Error(`no scripted reply for ${request.sessionId}`)
      return replyChunks(next)
    })
  }
}

describe('SubagentManager', () => {
  it('runs a background child and notifies the parent with its closing message', async () => {
    const { h, agents, root } = setup()
    routed(h, {
      root: [
        {
          tools: [
            {
              id: 'd1',
              name: 'subagent',
              args: { description: 'research', prompt: 'find x' },
            },
          ],
        },
        { text: 'waiting for the child' },
        { text: 'parent saw the notice' },
      ],
      child: [{ text: 'child result: x=42' }],
    })
    root.followup(userText('delegate'))
    await settleAll(agents)
    const started = root.session.lastOf('subagent/started')!
    expect(started.data).toMatchObject({
      description: 'research',
      mode: 'spawn',
      background: true,
      callId: 'd1',
    })
    const child = agents.get(started.data.subagentId)!
    expect(child.session.header).toMatchObject({
      origin: 'subagent',
      parentSession: 'root',
      delegationDepth: 1,
    })
    const childRequest = h.adapter.requests.find(
      (r) => r.sessionId === child.id,
    )!
    expect(textOf(childRequest)).toContain('Task: research\n\nfind x')
    const childContext = [childRequest.system, ...textOf(childRequest)].join(
      '\n',
    )
    expect(childContext).toContain('parent agent in Emperor Agent')
    expect(childContext).toContain('Verification')
    expect(childContext).toContain('Open items')
    expect(
      [h.adapter.requests[0]!.system, ...textOf(h.adapter.requests[0]!)].join(
        '\n',
      ),
    ).not.toContain('You are a delegated subagent working for a parent')
    expect(childRequest.tools?.map((t) => t.name)).toContain('report')
    expect(h.adapter.requests[0]!.tools?.map((t) => t.name)).not.toContain(
      'report',
    )
    const rootRequests = h.adapter.requests.filter(
      (r) => r.sessionId === 'root',
    )
    const settled = root.session.lastOf('subagent/settled')!
    expect(settled.data).toMatchObject({
      stopReason: 'completed',
      text: 'child result: x=42',
    })
    const notice = textOf(rootRequests.at(-1)!).join('\n')
    expect(notice).toContain(`Background subagent ${child.id} finished`)
    expect(notice).toContain('child result: x=42')
  })

  it('waits in the foreground and returns the child text as the tool result', async () => {
    const { h, agents, root } = setup()
    h.adapter.push(
      {
        tools: [
          {
            id: 'd1',
            name: 'subagent',
            args: {
              description: 'sum',
              prompt: '1+1',
              run_in_background: false,
            },
          },
        ],
      },
      { text: '2' },
      { text: 'the child said 2' },
    )
    root.followup(userText('go'))
    await settleAll(agents)
    const result = root.session.lastOf('tool/result')!
    expect(result.data.message.content[0].content).toEqual([
      { type: 'text', text: '2' },
    ])
    expect(
      root.session.events.filter((e) => e.type === 'turn/start'),
    ).toHaveLength(1)
  })

  it('forks with completed turns only and fixes the child permission scope', async () => {
    const { h, agents, root, manager } = setup()
    h.adapter.push({ text: 'first answer' })
    root.followup(userText('first'))
    await root.whenIdle()
    h.adapter.push(
      {
        tools: [
          {
            id: 'f1',
            name: 'subagent_fork',
            args: { description: 'review', prompt: 'review it' },
          },
        ],
      },
      { text: 'ok' },
      (request: GenerateOptions) => {
        const texts = textOf(request)
        expect(texts).toContain('first')
        expect(texts).toContain('first answer')
        expect(texts).not.toContain('second')
        return replyChunks({ text: 'reviewed' })
      },
      { text: 'noted' },
    )
    root.followup(userText('second'))
    await settleAll(agents)
    const childId = root.session.lastOf('subagent/started')!.data.subagentId
    const child = manager.get(childId)!
    const policyEvents = child.session.events.filter(
      (e) => e.type === 'sandbox/mode' || e.type === 'approval/policy',
    )
    expect(policyEvents.map((e) => e.data)).toEqual([
      { mode: 'workspace-write', source: 'delegation' },
      { policy: 'never', source: 'delegation' },
    ])
    expect(
      h.adapter.requests[2]!.messages.map((m) => messageText(m)).join('\n'),
    ).toContain('You are a delegated subagent')
  })

  it('refuses delegation beyond the depth limit', async () => {
    const { h, agents, root } = setup(0)
    h.adapter.push(
      {
        tools: [
          {
            id: 'x',
            name: 'subagent',
            args: { description: 'd', prompt: 'p' },
          },
        ],
      },
      { text: 'ok' },
    )
    root.followup(userText('go'))
    await settleAll(agents)
    const result = root.session.lastOf(
      'tool/result',
    )! as SessionEvent<'tool/result'>
    expect(result.data.message.content[0]).toMatchObject({ isError: true })
    expect(
      messageText({ content: result.data.message.content[0].content }),
    ).toMatch(/depth limit/)
  })

  it('send_message queues the next child turn and report steers the parent', async () => {
    const { h, agents, root, manager } = setup()
    routed(h, {
      root: [
        {
          tools: [
            {
              id: 'd1',
              name: 'subagent',
              args: { description: 'worker', prompt: 'start' },
            },
          ],
        },
        { text: 'started' },
        { text: 'parent ack' },
      ],
      child: [{ text: 'child done' }],
    })
    root.followup(userText('go'))
    await settleAll(agents)
    const childId = root.session.lastOf('subagent/started')!.data.subagentId
    routed(h, {
      root: [{ text: 'parent saw report' }, { text: 'parent saw settle' }],
      child: [
        {
          tools: [
            { id: 'r1', name: 'report', args: { output: 'partial finding' } },
          ],
        },
        { text: 'second done' },
      ],
    })
    manager.followup(root, childId, 'more work')
    await settleAll(agents)
    const continued = h.adapter.requests
      .filter((r) => r.sessionId === childId)
      .at(-1)!
    // send_message delivers the parent's words as written (no Task: header).
    expect(textOf(continued)).toContain('more work')
    expect(textOf(continued).join('\n')).not.toContain(
      'Task: worker\n\nmore work',
    )
    const rootTexts = root.session
      .deriveMessages()
      .map((m) => messageText(m))
      .join('\n')
    expect(rootTexts).toContain('partial finding')
    expect(() =>
      manager.interrupt(childId, {
        kind: 'ancestor',
        agent: agents.get(childId)!,
      }),
    ).toThrow(/not a live descendant/)
    expect(() =>
      manager.interrupt(childId, { kind: 'ancestor', agent: root }),
    ).not.toThrow()
  })

  it('lets a disposed child write its closing events before its log closes', async () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'subagent-dispose-'))
    const { h, agents, root, manager } = setup(undefined, logRoot)
    const hang = (request: GenerateOptions) =>
      new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(request.signal?.reason),
        )
      })
    const byOwner =
      (rootReply: Parameters<typeof replyChunks>[0]) =>
      (request: GenerateOptions) =>
        request.sessionId === 'root' ? replyChunks(rootReply) : hang(request)
    h.adapter.push(
      byOwner({
        tools: [
          {
            id: 'd1',
            name: 'subagent',
            args: { description: 'worker', prompt: 'start' },
          },
        ],
      }),
      byOwner({ text: 'started' }),
      byOwner({ text: 'started' }),
    )
    root.followup(userText('go'))
    const until = Date.now() + 3000
    while (!h.adapter.requests.some((r) => r.sessionId !== 'root')) {
      if (Date.now() > until) throw new Error('child never asked the model')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const childId = root.session.lastOf('subagent/started')!.data.subagentId
    const child = agents.get(childId)!
    manager.dispose(childId)
    await child.whenIdle()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const lines = readFileSync(join(logRoot, childId, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; data?: unknown })
    expect(lines.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
    })
    await settleAll(agents)
  })
})

describe('子智能体 settings in the manager (AGT-10)', () => {
  const delegate = {
    tools: [
      {
        id: 'd1',
        name: 'subagent',
        args: { description: 'worker', prompt: 'start' },
      },
    ],
  }

  it('4 · a chosen model entry runs the child while the parent keeps its own', async () => {
    let chosen: string | undefined = 'fast-route'
    const { h, agents, root } = setup(undefined, undefined, {
      childCallConfig: () =>
        chosen === undefined
          ? undefined
          : () => h.llm.defaultCallConfig(chosen),
    })
    h.llm.setRoutes(
      [testRoute(), testRoute({ id: 'fast-route', modelId: 'fast-model' })],
      'test-route',
    )
    routed(h, {
      root: [delegate, { text: 'started' }, { text: 'ack' }],
      child: [{ text: 'child done' }],
    })
    root.followup(userText('go'))
    await settleAll(agents)
    const childId = root.session.lastOf('subagent/started')!.data.subagentId
    const childRequest = h.adapter.requests.find(
      (r) => r.sessionId === childId,
    )!
    expect(childRequest.model).toBe('fast-model')
    expect(
      h.adapter.requests
        .filter((r) => r.sessionId === 'root')
        .map((r) => r.model),
    ).toEqual(['test-model', 'test-model', 'test-model'])

    // 跟随对话: no choice, the conversation's model.
    chosen = undefined
    routed(h, {
      root: [delegate, { text: 'started again' }, { text: 'ack again' }],
      child: [{ text: 'second child done' }],
    })
    root.followup(userText('again'))
    await settleAll(agents)
    const second = root.session.lastOf('subagent/started')!.data.subagentId
    expect(second).not.toBe(childId)
    expect(h.adapter.requests.find((r) => r.sessionId === second)!.model).toBe(
      'test-model',
    )
  })

  it('6 · the user writes to a live child: the message starts its next turn as the user', async () => {
    const { h, agents, root, manager } = setup()
    routed(h, {
      root: [delegate, { text: 'started' }, { text: 'ack' }],
      child: [{ text: 'child done' }],
    })
    root.followup(userText('go'))
    await settleAll(agents)
    const childId = root.session.lastOf('subagent/started')!.data.subagentId
    routed(h, {
      root: [{ text: 'parent saw the settle' }],
      child: [{ text: 'did the extra step' }],
    })
    manager.userFollowup(childId, '顺便把测试也跑一下')
    await settleAll(agents)
    const continued = h.adapter.requests
      .filter((r) => r.sessionId === childId)
      .at(-1)!
    expect(textOf(continued)).toContain('顺便把测试也跑一下')
    const message = agents
      .get(childId)!
      .session.deriveMessages()
      .find((m) => messageText(m) === '顺便把测试也跑一下')!
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'user' })
    expect(() => manager.userFollowup('sub-missing', 'hi')).toThrow(/not live/)
  })
})
