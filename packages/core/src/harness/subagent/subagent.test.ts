// Delegated subagents: background spawn + settlement notice to the parent,
// foreground wait, fork seeding (completed turns only), fixed permission
// scope, depth limit, send_message, interrupt authority, and report.
import { describe, expect, it } from 'vitest'
import { messageText, userText } from '../../llm/message'
import type { GenerateOptions } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import { Agent } from '../agent/agent'
import { ApprovalService } from '../approval/service'
import { SandboxPolicyService } from '../sandbox/policy'
import { createTestHarness, replyChunks, type TestHarness } from '../testing'
import { SubagentManager } from './manager'
import { installSubagents } from './tools'

function setup(maxDepth?: number): {
  h: TestHarness
  manager: SubagentManager
  agents: Map<string, Agent>
  root: Agent
} {
  const h = createTestHarness()
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
    expect(textOf(childRequest)).toContain('find x')
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
})
