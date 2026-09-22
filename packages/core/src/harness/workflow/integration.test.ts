// The workflow + ralph tools over the REAL in-process stack (ported from
// dsh-workflow-worker-thread `integration.spec.ts` and dsh-tool-ralph
// `integration.spec.ts`): a scripted root agent calls the tool, the worker
// thread runs the script, and every agent() spawns a real delegated subagent
// through SubagentManager — structured children finish via structured_output.
import { describe, expect, it } from 'vitest'
import { messageText, userText } from '../../llm/message'
import type { GenerateOptions, StreamChunk } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import { Agent } from '../agent/agent'
import { ApprovalService } from '../approval/service'
import { SessionProjector } from '../projection/projector'
import { SandboxPolicyService } from '../sandbox/policy'
import { SubagentManager } from '../subagent/manager'
import { installSubagents } from '../subagent/tools'
import { createTestHarness, replyChunks, type TestHarness } from '../testing'
import { WorkflowEngine } from './engine'
import { createSpawnChildProvider } from './provider'
import { WorkflowRunFold, WorkflowRunRegistry } from './records'
import { installWorkflow, RALPH_SCRIPT } from './tools'

interface Stack {
  h: TestHarness
  manager: SubagentManager
  agents: Map<string, Agent>
  root: Agent
  runs: WorkflowRunRegistry
  engine: WorkflowEngine
}

function setup(): Stack {
  const h = createTestHarness()
  const agents = new Map<string, Agent>()
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
    sandbox: new SandboxPolicyService({
      defaultMode: 'workspace-write',
      workspaceRoot: '/workspace',
    }),
    approval: new ApprovalService('ask'),
  })
  installSubagents(manager, h.tools, h.prompt)
  const engine = new WorkflowEngine(
    [createSpawnChildProvider({ manager, llm: h.llm })],
    { maxConcurrentAgents: 4, disposeGraceMs: 500 },
  )
  const runs = new WorkflowRunRegistry()
  installWorkflow(h.tools, h.prompt, { engine, runs })
  const root = h.agent('root')
  agents.set(root.id, root)
  return { h, manager, agents, root, runs, engine }
}

type Responder = (request: GenerateOptions) => Parameters<typeof replyChunks>[0]

/** Answer every model request through one routing function. */
function respond(h: TestHarness, responder: Responder, count = 40): void {
  for (let index = 0; index < count; index++)
    h.adapter.push((request: GenerateOptions): StreamChunk[] =>
      replyChunks(responder(request)),
    )
}

function firstUserText(request: GenerateOptions): string {
  const first = request.messages.find((message) => message.role === 'user')
  return first === undefined ? '' : messageText(first)
}

function hasToolResult(request: GenerateOptions): boolean {
  return request.messages.some(
    (message) => message.role === 'user' && message.source.kind === 'tool',
  )
}

async function settle(stack: Stack, check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 8000) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await stack.root.whenIdle()
}

function toolResultText(
  events: readonly SessionEvent[],
  callId: string,
): string {
  const result = events.find(
    (event): event is SessionEvent<'tool/result'> =>
      event.type === 'tool/result' &&
      event.data.message.source.callId === callId,
  )
  if (result === undefined) throw new Error(`no tool result for ${callId}`)
  return JSON.stringify(result.data)
}

describe('workflow tool over the real in-process stack', () => {
  it('runs a two-stage workflow: a plain child, then a schema child through structured_output', async () => {
    const stack = setup()
    const { h, root } = stack
    const childRequests: GenerateOptions[] = []
    respond(h, (request) => {
      if (request.sessionId === 'root') {
        if (!hasToolResult(request))
          return {
            tools: [
              {
                id: 'wf-1',
                name: 'workflow',
                args: {
                  meta: {
                    name: 'demo',
                    description: 'two stages',
                    phases: [{ title: 'find' }, { title: 'judge' }],
                  },
                  script: `
                    phase('find')
                    const found = await agent('find the answer', { label: 'finder' })
                    phase('judge')
                    const verdict = await agent('judge: ' + found, {
                      schema: {
                        type: 'object',
                        properties: { ok: { type: 'boolean' }, why: { type: 'string' } },
                        required: ['ok', 'why'],
                        additionalProperties: false,
                      },
                    })
                    log('judged')
                    return { found, verdict }`,
                },
              },
            ],
          }
        return { text: 'workflow finished' }
      }
      childRequests.push(request)
      if (firstUserText(request).startsWith('find'))
        return { text: 'answer=42' }
      // The structured child: first a bad call (schema violation), then a valid one.
      if (!hasToolResult(request))
        return {
          tools: [{ name: 'structured_output', args: { ok: 'yes' } }],
        }
      return {
        tools: [
          { name: 'structured_output', args: { ok: true, why: 'checked' } },
        ],
      }
    })
    root.followup(userText('run the demo workflow'))
    await settle(stack, () =>
      root.session.events.some(
        (event) => event.type === 'tool-workflow/run-end',
      ),
    )
    const events = root.session.events
    const resultText = toolResultText(events, 'wf-1')
    expect(resultText).toContain('workflow \\"demo\\" completed (2 agents)')
    expect(resultText).toContain('answer=42')
    expect(resultText).toContain('checked')

    // Children are real delegated subagents attached to the workflow tool call.
    const started = events.filter(
      (event): event is SessionEvent<'subagent/started'> =>
        event.type === 'subagent/started',
    )
    expect(started.map((event) => event.data)).toEqual([
      expect.objectContaining({
        description: 'finder',
        mode: 'spawn',
        background: false,
        callId: 'wf-1',
      }),
      expect.objectContaining({ callId: 'wf-1', background: false }),
    ])
    expect(
      events.filter((event) => event.type === 'subagent/settled'),
    ).toHaveLength(2)
    // Collected children are disposed (dsh semantics); no parent notice was sent.
    for (const event of started)
      expect(stack.manager.get(event.data.subagentId)).toBeUndefined()
    expect(
      events.some(
        (event) =>
          event.type === 'user/message' &&
          event.data.source.kind === 'context' &&
          event.data.source.form === 'notice',
      ),
    ).toBe(false)

    // Only the structured child sees structured_output, with its own schema.
    const judgeRequest = childRequests.find((request) =>
      firstUserText(request).startsWith('judge'),
    )!
    const structuredTool = judgeRequest.tools?.find(
      (tool) => tool.name === 'structured_output',
    )
    expect(structuredTool?.parameters).toMatchObject({
      required: ['ok', 'why'],
    })
    expect(judgeRequest.system).toContain('structured_output')
    const finderRequest = childRequests.find((request) =>
      firstUserText(request).startsWith('find'),
    )!
    expect(
      finderRequest.tools?.some((tool) => tool.name === 'structured_output'),
    ).toBe(false)
    // The invalid first capture was rejected back to the child.
    const retried = childRequests.find(
      (request) =>
        firstUserText(request).startsWith('judge') && hasToolResult(request),
    )!
    expect(JSON.stringify(retried.messages)).toContain(
      'missing required property',
    )

    // Durable record: run-start, phases, members, log, run-end.
    const [record] = WorkflowRunFold.fold(events)
    expect(record).toMatchObject({
      name: 'demo',
      tool: 'workflow',
      callId: 'wf-1',
      status: 'completed',
      agentsStarted: 2,
      currentPhase: 'judge',
    })
    expect(record!.agents.map((agent) => agent.outcome)).toEqual([
      'completed',
      'completed',
    ])
    expect(record!.narration.map((entry) => entry.text)).toEqual([
      'find',
      'judge',
      'judged',
    ])
    expect(stack.runs.isLive(record!.runId)).toBe(false)

    // The projector turns the records into renderer events.
    const ui = SessionProjector.projectAll(events, { sessionId: 'root' })
    const names = ui.map((event) => event.event)
    expect(names).toContain('workflow_started')
    expect(names).toContain('workflow_progress')
    expect(names).toContain('workflow_finished')
    const finished = ui.find((event) => event.event === 'workflow_finished')!
    expect(finished.task).toMatchObject({
      id: record!.runId,
      kind: 'workflow',
      status: 'completed',
      rounds: 2,
      workflow_tool: 'workflow',
    })
    expect(
      ui.filter(
        (event) =>
          event.event === 'subagent_start' && event.parent_id === 'wf-1',
      ),
    ).toHaveLength(2)
  })

  it('maps a script failure to an error tool result and still records run-end', async () => {
    const stack = setup()
    const { h, root } = stack
    respond(h, (request) =>
      hasToolResult(request)
        ? { text: 'saw the error' }
        : {
            tools: [
              {
                id: 'wf-err',
                name: 'workflow',
                args: {
                  meta: { name: 'broken', description: 'throws' },
                  script: `throw new Error('script exploded')`,
                },
              },
            ],
          },
    )
    root.followup(userText('go'))
    await settle(stack, () =>
      root.session.events.some(
        (event) => event.type === 'tool-workflow/run-end',
      ),
    )
    const text = toolResultText(root.session.events, 'wf-err')
    expect(text).toContain('workflow run failed')
    expect(text).toContain('script exploded')
    const [record] = WorkflowRunFold.fold(root.session.events)
    expect(record).toMatchObject({ status: 'error' })
  })

  it('reports invalid meta synchronously as a correctable tool error', async () => {
    const stack = setup()
    const { h, root } = stack
    respond(h, (request) =>
      hasToolResult(request)
        ? { text: 'ok' }
        : {
            tools: [
              {
                id: 'wf-meta',
                name: 'workflow',
                args: {
                  meta: { name: 'x', description: 'y', bogus: 1 },
                  script: 'return 1',
                },
              },
            ],
          },
    )
    root.followup(userText('go'))
    await settle(stack, () =>
      root.session.events.some(
        (event) =>
          event.type === 'tool/result' &&
          event.data.message.source.callId === 'wf-meta',
      ),
    )
    expect(toolResultText(root.session.events, 'wf-meta')).toContain(
      'meta.bogus is not a recognized field',
    )
    expect(WorkflowRunFold.fold(root.session.events)).toEqual([])
  })

  it('cancels the run and its children when the parent turn is cancelled', async () => {
    const stack = setup()
    const { h, root } = stack
    let childStarted = false
    for (let index = 0; index < 5; index++)
      h.adapter.push((request: GenerateOptions) => {
        if (request.sessionId === 'root')
          return replyChunks(
            hasToolResult(request)
              ? { text: 'after cancel' }
              : {
                  tools: [
                    {
                      id: 'wf-cancel',
                      name: 'workflow',
                      args: {
                        meta: { name: 'slow', description: 'hangs' },
                        script: `return await agent('hang forever')`,
                      },
                    },
                  ],
                },
          )
        childStarted = true
        return new Promise<StreamChunk[]>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(request.signal?.reason)
          })
        })
      })
    root.followup(userText('go'))
    const start = Date.now()
    while (!childStarted) {
      if (Date.now() - start > 5000) throw new Error('child never started')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    root.cancel({ kind: 'user' })
    await settle(stack, () =>
      root.session.events.some(
        (event) => event.type === 'tool-workflow/run-end',
      ),
    )
    const [record] = WorkflowRunFold.fold(root.session.events)
    expect(record?.status).toBe('cancelled')
    expect(record?.agents[0]?.outcome).toBe('cancelled')
  })
})

describe('ralph tool over the real in-process stack', () => {
  const report = (
    status: 'continue' | 'complete' | 'blocked',
    summary: string,
  ): Record<string, unknown> => ({
    status,
    summary,
    evidence: status === 'continue' ? [] : ['tests pass'],
    nextSteps: status === 'continue' ? ['keep going'] : [],
    blocker: status === 'blocked' ? 'need a human' : '',
  })

  it('uses fresh children with only the prior bounded handoff and renders completion', async () => {
    const stack = setup()
    const { h, root } = stack
    const childPrompts: string[] = []
    respond(h, (request) => {
      if (request.sessionId === 'root')
        return hasToolResult(request)
          ? { text: 'ralph done' }
          : {
              tools: [
                {
                  id: 'ralph-1',
                  name: 'ralph',
                  args: { objective: 'ship the feature', maxRounds: 3 },
                },
              ],
            }
      const prompt = firstUserText(request)
      if (!childPrompts.includes(prompt)) childPrompts.push(prompt)
      const round = childPrompts.indexOf(prompt) + 1
      return {
        tools: [
          {
            name: 'structured_output',
            args:
              round === 1
                ? report('continue', 'did step one')
                : report('complete', 'all done'),
          },
        ],
      }
    })
    root.followup(userText('use ralph'))
    await settle(stack, () =>
      root.session.events.some(
        (event) => event.type === 'tool-workflow/run-end',
      ),
    )
    const text = toolResultText(root.session.events, 'ralph-1')
    expect(text).toContain('Ralph worker reported completion after 2 rounds.')
    expect(childPrompts).toHaveLength(2)
    expect(childPrompts[0]).toContain(
      'Immutable objective:\\nship the feature'.replace('\\n', '\n'),
    )
    expect(childPrompts[0]).toContain('(none — this is the first round)')
    expect(childPrompts[0]).toContain('Ralph round: 1 of 3.')
    expect(childPrompts[1]).toContain('did step one')
    // Fresh children: neither sees the parent conversation.
    expect(childPrompts.join('\n')).not.toContain('use ralph')
    const [record] = WorkflowRunFold.fold(root.session.events)
    expect(record).toMatchObject({
      tool: 'ralph',
      name: 'ralph-loop',
      status: 'completed',
      agentsStarted: 2,
    })
    expect(record!.agents.map((agent) => agent.label)).toEqual([
      'Ralph round 1',
      'Ralph round 2',
    ])
  })

  it('reports the failed round and the last good handoff when a child fails', async () => {
    const stack = setup()
    const { h, root } = stack
    let childTurns = 0
    respond(h, (request) => {
      if (request.sessionId === 'root')
        return hasToolResult(request)
          ? { text: 'saw failure' }
          : {
              tools: [
                {
                  id: 'ralph-f',
                  name: 'ralph',
                  args: { objective: 'fix it', maxRounds: 4 },
                },
              ],
            }
      childTurns += 1
      // Round 1 reports; round 2 answers in plain text (no structured capture).
      return childTurns === 1
        ? {
            tools: [
              {
                name: 'structured_output',
                args: report('continue', 'half way'),
              },
            ],
          }
        : { text: 'I forgot the tool' }
    })
    root.followup(userText('go'))
    await settle(stack, () =>
      root.session.events.some(
        (event) => event.type === 'tool-workflow/run-end',
      ),
    )
    const text = toolResultText(root.session.events, 'ralph-f')
    expect(text).toContain(
      'Ralph round 2 child failed before producing a structured report.',
    )
    expect(text).toContain('half way')
  })

  it('rejects a round cap above the standard preset ceiling (64) before starting', async () => {
    const stack = setup()
    const { h, root } = stack
    respond(h, (request) =>
      hasToolResult(request)
        ? { text: 'ok' }
        : {
            tools: [
              {
                id: 'ralph-cap',
                name: 'ralph',
                args: { objective: 'x', maxRounds: 65 },
              },
            ],
          },
    )
    root.followup(userText('go'))
    await settle(stack, () =>
      root.session.events.some(
        (event) =>
          event.type === 'tool/result' &&
          event.data.message.source.callId === 'ralph-cap',
      ),
    )
    expect(toolResultText(root.session.events, 'ralph-cap')).toContain(
      'Ralph maxRounds 65 exceeds the deployment ceiling 64',
    )
    expect(RALPH_SCRIPT).toContain('Fresh-agent rounds')
  })
})
