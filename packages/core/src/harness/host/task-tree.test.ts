// KRN-03: one root session owns its task tree — every subagent it (and its
// subagents) started, their sessions, background jobs and spill — and one
// budget bounds the tree: steps per turn, a cost cap counted over the root,
// every child and failed attempts, a shared pool of running subagents, a
// total per task, and how often subagent results may wake their parent.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from '../../api/core-api'
import { makeApi, tmp, waitFor } from '../../api/test-helpers'
import type { LlmAdapter } from '../../llm/adapter'
import { LlmClient } from '../../llm/client'
import { messageText, userText } from '../../llm/message'
import type { RouteSpec } from '../../llm/route'
import type { GenerateOptions, StreamChunk, TokenUsage } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import { assertRequestInvariant } from '../agent/invariant'
import {
  createTestHarness,
  replyChunks,
  testRoute,
  withTaskBudget,
} from '../testing'
import { spillSessionDir } from '../tools/spill'
import type { HarnessHost } from './host'
import { recordedDescendants } from './task-tree'

type Reply = Parameters<typeof replyChunks>[0]

const VIEW = { sessionId: null }
const FREE: TokenUsage = { inputTokens: 0, outputTokens: 0 }
/** $0.30 at the priced route below ($1 per million input tokens). */
const THIRTY_CENTS: TokenUsage = { inputTokens: 300_000, outputTokens: 0 }

const apis: CoreApi[] = []

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

/** A model that answers every request through `respond` (by session, by task). */
class RoutedAdapter implements LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly respond: (
      request: GenerateOptions,
    ) => Reply | StreamChunk[] | Promise<Reply | StreamChunk[]>,
  ) {}

  async *stream(
    _route: RouteSpec,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    // Titles and summaries are not the conversation's requests.
    if (options.purpose !== undefined) {
      yield* replyChunks({ text: 'Summary of the earlier steps.' })
      return
    }
    this.requests.push(options)
    const signal = options.signal
    const reply = await new Promise<Reply | StreamChunk[]>(
      (resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        const onAbort = (): void => reject(signal!.reason)
        signal?.addEventListener('abort', onAbort, { once: true })
        Promise.resolve(this.respond(options))
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', onAbort))
      },
    )
    for (const chunk of Array.isArray(reply) ? reply : replyChunks(reply))
      yield chunk
  }
}

/** The subagent task (`Task: <description>`) a child request carries, if any. */
function taskOf(request: GenerateOptions): string | undefined {
  for (const message of request.messages) {
    const match = /^Task: (\S+)/.exec(messageText(message))
    if (match) return match[1]
  }
  return undefined
}

/** One deferred reply per name, released by the test (either side may come first). */
function gates(): {
  wait(name: string): Promise<void>
  release(name: string): void
} {
  const entries = new Map<string, { promise: Promise<void>; open(): void }>()
  const entry = (name: string) => {
    let found = entries.get(name)
    if (found === undefined) {
      let open!: () => void
      const promise = new Promise<void>((resolve) => {
        open = resolve
      })
      found = { promise, open }
      entries.set(name, found)
    }
    return found
  }
  return {
    wait: (name) => entry(name).promise,
    release: (name) => entry(name).open(),
  }
}

function pricedConfig(capUsd: number): Record<string, unknown> {
  return {
    schemaVersion: 2,
    activeModelId: 'test-route',
    models: [
      {
        entryId: 'test-route',
        provider: 'deepseek',
        protocol: 'openai',
        modelId: 'test-model',
        displayName: 'Test',
        apiBase: 'https://api.deepseek.com',
        apiKey: null,
        contextWindowTokens: 100000,
        maxTokens: 4096,
        pricing: {
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 0,
          cacheReadUsdPerMillionTokens: 0,
          cacheWriteUsdPerMillionTokens: 0,
        },
      },
    ],
    policy: { cost: { maxUsdPerAgentTurn: capUsd } },
  }
}

interface Tree {
  api: CoreApi
  host: HarnessHost
  adapter: RoutedAdapter
  stateRoot: string
  rootId: string
  submit(content: string): ReturnType<HarnessHost['submit']>
  events(sessionId?: string): SessionEvent[]
  /** Children the root's log recorded, in start order. */
  children(): Array<{ id: string; description: string }>
  childRequests(): GenerateOptions[]
  /** Every agent of the tree idle. */
  quiet(): Promise<void>
}

async function makeTree(
  respond: (
    request: GenerateOptions,
    tree: { rootId: string },
  ) => Reply | StreamChunk[] | Promise<Reply | StreamChunk[]>,
  options: {
    modelConfig?: Record<string, unknown>
    retries?: boolean
  } = {},
): Promise<Tree> {
  const root = tmp('emperor-task-tree-')
  const stateRoot = join(root, 'home')
  if (options.modelConfig !== undefined) {
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(
      join(stateRoot, 'model_config.json'),
      JSON.stringify(options.modelConfig),
    )
  }
  const ids = { rootId: '' }
  const adapter = new RoutedAdapter((request) => respond(request, ids))
  const ref: { api?: CoreApi } = {}
  const llm = new LlmClient({
    adapterFor: () => adapter,
    onRequest: (request) => {
      assertRequestInvariant(request, (id) => ref.api?.host.sessionLog(id))
    },
  })
  llm.setRoutes([testRoute({ id: 'test-route' })], 'test-route')
  const { api } = await makeApi({ root, stateRoot, extra: { llm } })
  ref.api = api
  apis.push(api)
  const host = api.host
  // A second session: the root can be deleted (never the last one).
  api.sessions.create({ title: 'other' })
  ids.rootId = String(api.sessions.create({ title: 'root' }).id)
  const events = (sessionId = ids.rootId): SessionEvent[] => [
    ...(host.sessionLog(sessionId)?.events ?? []),
  ]
  const children = () =>
    events().flatMap((event) =>
      event.type === 'subagent/started'
        ? [{ id: event.data.subagentId, description: event.data.description }]
        : [],
    )
  return {
    api,
    host,
    adapter,
    stateRoot,
    rootId: ids.rootId,
    submit: (content) => host.submit({ sessionId: ids.rootId, content }),
    events,
    children,
    childRequests: () =>
      adapter.requests.filter((request) => request.sessionId !== ids.rootId),
    quiet: async () => {
      for (let round = 0; round < 4; round++) {
        await waitFor(
          () =>
            !host.isBusy(ids.rootId) &&
            host.taskTreeForTest(ids.rootId)?.childrenActive() !== true,
          10_000,
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

/** A queue of replies for the root; once empty, `fallback`. */
function script(replies: Reply[], fallback: Reply = { text: 'ack' }) {
  const queue = [...replies]
  return (): Reply => queue.shift() ?? fallback
}

const subagent = (
  description: string,
  extra: Record<string, unknown> = {},
): { id: string; name: string; args: Record<string, unknown> } => ({
  id: `start-${description}`,
  name: 'subagent',
  args: { description, prompt: `do ${description}`, ...extra },
})

function lastTurnEnd(events: readonly SessionEvent[]) {
  return [...events]
    .reverse()
    .find(
      (event): event is SessionEvent<'turn/end'> => event.type === 'turn/end',
    )?.data.reason
}

describe('KRN-03 task tree: lifecycle', () => {
  it('#1 a disposed subagent leaves the host tables (workflow child, then stop)', async () => {
    const root = script([
      {
        tools: [
          {
            id: 'wf',
            name: 'workflow',
            args: {
              meta: { name: 'one-leaf', description: 'one agent' },
              script: "return await agent('leaf task', { label: 'leaf' })",
            },
          },
        ],
      },
      { text: 'workflow done' },
      { tools: [subagent('bg')] },
      { text: 'started' },
    ])
    const t = await makeTree((request, { rootId }) =>
      request.sessionId === rootId ? root() : { text: 'child done' },
    )
    await t.submit('run the workflow')
    const [leaf] = t.children()
    expect(leaf?.description).toBe('leaf')
    // The workflow disposed its collected child: nothing in the host keeps it.
    await waitFor(() => !t.host.attachedForTest().agents.includes(leaf!.id))
    const afterWorkflow = t.host.attachedForTest()
    expect(afterWorkflow.agents).not.toContain(leaf!.id)
    expect(afterWorkflow.projectors).not.toContain(leaf!.id)
    expect(afterWorkflow.unsubscribes).not.toContain(leaf!.id)

    // A background child stays addressable until the root stops.
    await t.submit('start a background child')
    await t.quiet()
    const bg = t.children()[1]!
    expect(t.host.attachedForTest().agents).toContain(bg.id)
    t.host.stop(t.rootId)
    await waitFor(() => !t.host.attachedForTest().agents.includes(bg.id))
    const afterStop = t.host.attachedForTest()
    expect(afterStop.projectors).not.toContain(bg.id)
    expect(afterStop.unsubscribes).not.toContain(bg.id)
    expect(afterStop.agents).toContain(t.rootId)
  })

  it("#2 a subagent's background bash job is killed when the root stops", async () => {
    const root = script([{ tools: [subagent('server')] }, { text: 'waiting' }])
    const child = script([
      {
        tools: [
          {
            id: 'sleep',
            name: 'bash',
            args: {
              command: 'sleep 30',
              description: 'Sleep a while',
              run_in_background: true,
            },
          },
        ],
      },
      { text: 'started the job' },
    ])
    const t = await makeTree((request, { rootId }) =>
      request.sessionId === rootId ? root() : child(),
    )
    await t.submit('start a server in a subagent')
    await waitFor(() => t.children().length === 1)
    const childId = t.children()[0]!.id
    await waitFor(() =>
      t.events(childId).some((event) => event.type === 'job/started'),
    )
    const owner = t.host.subagents.get(childId)!
    expect(t.host.jobs.list(owner).map((job) => job.status)).toEqual([
      'running',
    ])
    t.host.stop(t.rootId)
    await waitFor(() =>
      t.events(childId).some((event) => event.type === 'job/finished'),
    )
    const finished = t
      .events(childId)
      .find(
        (event): event is SessionEvent<'job/finished'> =>
          event.type === 'job/finished',
      )!
    expect(finished.data.status).toBe('killed')
    expect(t.host.jobs.list(owner)).toEqual([])
  })

  it('#3 purging a deleted root removes its subagent sessions and spill', async () => {
    const big = (description: string) => ({
      id: `print-${description}`,
      name: 'bash',
      args: {
        command: "head -c 60000 /dev/zero | tr '\\0' a",
        description: 'Print a lot',
      },
    })
    const root = script([
      { tools: [big('root')] },
      { tools: [subagent('printer', { run_in_background: false })] },
      { text: 'done' },
    ])
    const child = script([{ tools: [big('child')] }, { text: 'printed' }])
    const t = await makeTree((request, { rootId }) =>
      request.sessionId === rootId ? root() : child(),
    )
    await t.submit('print a lot, twice')
    await t.quiet()
    const childId = t.children()[0]!.id
    const sessions = join(t.stateRoot, 'sessions')
    const spill = join(t.stateRoot, 'spill')
    expect(existsSync(join(sessions, childId))).toBe(true)
    expect(existsSync(spillSessionDir(spill, t.rootId))).toBe(true)
    expect(existsSync(spillSessionDir(spill, childId))).toBe(true)

    await t.api.sessions.delete(t.rootId)
    // Still restorable: the child session waits with its root.
    expect(existsSync(join(sessions, childId))).toBe(true)
    await t.api.sessions.purgeDeleted(t.rootId)
    expect(existsSync(join(sessions, childId))).toBe(false)
    expect(existsSync(spillSessionDir(spill, t.rootId))).toBe(false)
    expect(existsSync(spillSessionDir(spill, childId))).toBe(false)
    expect(readdirSync(sessions)).not.toContain(t.rootId)
  })
})

describe('KRN-03 task tree: subagent budget', () => {
  it('#4 the ninth concurrent subagent waits for a free slot', async () => {
    const gate = gates()
    let inFlight = 0
    let peak = 0
    const names = Array.from({ length: 9 }, (_, index) => `c${index + 1}`)
    const root = script([
      { tools: names.map((name) => subagent(name)) },
      { text: 'waiting' },
    ])
    const t = await makeTree(async (request, { rootId }) => {
      if (request.sessionId === rootId) return root()
      const name = taskOf(request)!
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await gate.wait(name)
      inFlight -= 1
      return { text: `${name} done` }
    })
    await t.submit('start nine')
    await waitFor(() => t.childRequests().length === 8)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(t.childRequests()).toHaveLength(8)
    const ninth = t.children().find((child) => child.description === 'c9')!
    expect(t.host.subagents.record(ninth.id)?.status).toBe('idle')
    expect(
      t.childRequests().some((request) => request.sessionId === ninth.id),
    ).toBe(false)
    // Its task waits in its own queue.
    expect(
      t.host.subagents.get(ninth.id)!.inbox.nextTurn.map(messageText),
    ).toEqual(['Task: c9\n\ndo c9'])

    gate.release('c1')
    await waitFor(() =>
      t.childRequests().some((request) => request.sessionId === ninth.id),
    )
    for (const name of names) gate.release(name)
    await t.quiet()
    expect(peak).toBe(8)
    expect(t.childRequests()).toHaveLength(9)
  })

  it('#5 the 65th subagent of one task is refused with AGENT_BUDGET_EXCEEDED', async () => {
    const names = Array.from({ length: 65 }, (_, index) => `s${index + 1}`)
    const root = script([
      { tools: names.map((name) => subagent(name)), usage: FREE },
      { text: 'waiting', usage: FREE },
    ])
    const t = await makeTree((request, { rootId }) =>
      request.sessionId === rootId ? root() : { text: 'ok', usage: FREE },
    )
    await t.submit('start sixty-five')
    await t.quiet()
    expect(t.children()).toHaveLength(64)
    const refused = t
      .events()
      .find(
        (event): event is SessionEvent<'tool/result'> =>
          event.type === 'tool/result' &&
          event.data.message.source.callId === 'start-s65',
      )!
    expect(refused.data.error?.code).toBe('AGENT_BUDGET_EXCEEDED')
    const [result] = refused.data.message.content
    expect(
      result.content.map((block) => ('text' in block ? block.text : '')),
    ).toEqual([expect.stringContaining('AGENT_BUDGET_EXCEEDED: this task')])
    expect(
      t.events().filter((event) => event.type === 'tool/result'),
    ).toHaveLength(65)
  }, 120_000)

  it('#12 the 33rd subagent result does not wake its parent and leaves a hint', async () => {
    const gate = gates()
    const names = Array.from({ length: 33 }, (_, index) => `w${index + 1}`)
    const root = script([
      { tools: names.map((name) => subagent(name)) },
      { text: 'waiting' },
    ])
    const t = await makeTree(async (request, { rootId }) => {
      if (request.sessionId === rootId) return root()
      const name = taskOf(request)!
      await gate.wait(name)
      return { text: `${name} done` }
    })
    await t.submit('start thirty-three')
    const turns = () =>
      t.events().filter((event) => event.type === 'turn/end').length
    const settled = (name: string) => {
      const child = t.children().find((entry) => entry.description === name)
      return t
        .events()
        .some(
          (event) =>
            event.type === 'subagent/settled' &&
            event.data.subagentId === child?.id,
        )
    }
    const base = turns()
    for (let index = 0; index < 32; index++) {
      gate.release(names[index]!)
      // Each result wakes the idle root for one turn.
      await waitFor(() => turns() === base + index + 1, 10_000)
      await waitFor(() => !t.host.isBusy(t.rootId))
    }
    gate.release('w33')
    await waitFor(() => settled('w33'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(turns()).toBe(base + 32)
    expect(t.host.isBusy(t.rootId)).toBe(false)
    const agent = t.host.agentFor(t.rootId)
    // The result waits for the next step instead of waking the root.
    expect(agent.inbox.nextStep.map(messageText).join('\n')).toContain(
      'w33 done',
    )
    // The model and the user can see why it did not wake.
    const hint = t
      .events()
      .filter(
        (event): event is SessionEvent<'user/message'> =>
          event.type === 'user/message' &&
          event.data.source.kind === 'context' &&
          event.data.source.producer === 'task-budget',
      )
      .at(-1)
    expect(messageText(hint!.data)).toContain('32')
    expect(hint!.data.source).toMatchObject({ form: 'notice' })
    expect(
      hint!.data.source.kind === 'context' ? hint!.data.source.summary : '',
    ).toContain('32')

    // The user's next message delivers the waiting result.
    await t.submit('what happened?')
    const last = t.adapter.requests.at(-1)!
    expect(last.messages.map(messageText).join('\n')).toContain('w33 done')
  }, 120_000)
})

describe('KRN-03 task tree: cost and steps', () => {
  it('#6 a $1 cap over five $0.30 subagents stops after the fourth request', async () => {
    const names = ['c1', 'c2', 'c3', 'c4', 'c5']
    const root = script(
      [
        { tools: names.map((name) => subagent(name)), usage: FREE },
        { text: 'waiting', usage: FREE },
      ],
      { text: 'ack', usage: FREE },
    )
    const steps = new Map<string, number>()
    const spentWhenIssued: boolean[] = []
    const ref: { host?: HarnessHost } = {}
    const t = await makeTree(
      (request, { rootId }) => {
        spentWhenIssued.push(
          ref.host?.taskTreeForTest(rootId)?.verdict().kind === 'exceeded',
        )
        if (request.sessionId === rootId) return root()
        const name = taskOf(request)!
        const step = (steps.get(name) ?? 0) + 1
        steps.set(name, step)
        return step === 1
          ? {
              tools: [
                {
                  id: `todo-${name}`,
                  name: 'todo_write',
                  args: { todos: [] },
                },
              ],
              usage: THIRTY_CENTS,
            }
          : { text: `${name} done`, usage: FREE }
      },
      { modelConfig: pricedConfig(1) },
    )
    ref.host = t.host
    // One subagent at a time, so the order of the spend is fixed.
    await t.api.tasks.setBudget({ maxActiveAgents: 1 }, VIEW)
    await t.submit('five children, thirty cents each')
    await t.quiet()

    // Requests per child: the fourth $0.30 crossed the cap; c4 made no
    // second request and c5 none at all.
    expect([...steps.entries()]).toEqual([
      ['c1', 2],
      ['c2', 2],
      ['c3', 2],
      ['c4', 1],
    ])
    // Nothing asked the model anything once the cap was crossed.
    expect(spentWhenIssued.filter(Boolean)).toEqual([])
    const c4 = t.children().find((child) => child.description === 'c4')!
    expect(lastTurnEnd(t.events(c4.id))).toEqual({
      kind: 'budget',
      limit: 'cost',
      capUsdNanos: 1_000_000_000,
      spentUsdNanos: 1_200_000_000,
    })
    const c5 = t.children().find((child) => child.description === 'c5')!
    expect(
      t.childRequests().some((request) => request.sessionId === c5.id),
    ).toBe(false)
  })

  it('#7 a failed attempt counts toward the cost cap', async () => {
    const SIXTY_CENTS: TokenUsage = { inputTokens: 600_000, outputTokens: 0 }
    const root = script([
      [
        { type: 'usage', usage: SIXTY_CENTS },
        {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'upstream hiccup', code: 'SERVER' },
          },
        },
      ],
      {
        tools: [{ id: 'todo', name: 'todo_write', args: { todos: [] } }],
        usage: SIXTY_CENTS,
      },
      { text: 'never reached', usage: FREE },
    ])
    const t = await makeTree(
      (request, { rootId }) =>
        request.sessionId === rootId ? root() : { text: 'x' },
      { modelConfig: pricedConfig(1) },
    )
    const submitted = await t.submit('go')
    expect(t.adapter.requests).toHaveLength(2)
    expect(lastTurnEnd(t.events())).toEqual({
      kind: 'budget',
      limit: 'cost',
      capUsdNanos: 1_000_000_000,
      spentUsdNanos: 1_200_000_000,
    })
    expect(submitted.result).toMatchObject({
      kind: 'blocked',
      reason: 'cost-cap',
    })
  })

  it('#8 an interactive turn stops at step 401 and tells the model and the user', async () => {
    let calls = 0
    const t = await makeTree((request, { rootId }) => {
      if (request.sessionId !== rootId) return { text: 'x' }
      calls += 1
      return calls <= 400
        ? {
            tools: [
              { id: `todo-${calls}`, name: 'todo_write', args: { todos: [] } },
            ],
          }
        : { text: 'after the stop' }
    })
    const ui: Array<Record<string, unknown>> = []
    const untap = t.host.tap((event) => {
      ui.push(event)
    })
    const submitted = await t.submit('loop forever')
    untap()
    expect(t.adapter.requests).toHaveLength(400)
    expect(lastTurnEnd(t.events())).toEqual({
      kind: 'budget',
      limit: 'steps',
      maxSteps: 400,
    })
    expect(submitted.result).toMatchObject({
      kind: 'blocked',
      reason: 'step-limit',
    })
    // The user: the turn's end says why.
    expect(ui).toContainEqual(
      expect.objectContaining({
        event: 'assistant_done',
        stop_reason: 'budget',
      }),
    )
    // The model: a notice in the log, read with the next request.
    const notice = t
      .events()
      .find(
        (event): event is SessionEvent<'user/message'> =>
          event.type === 'user/message' &&
          event.data.source.kind === 'context' &&
          event.data.source.producer === 'task-budget',
      )!
    expect(messageText(notice.data)).toContain('400 steps')
    await t.submit('carry on')
    expect(
      t.adapter.requests.at(-1)!.messages.map(messageText).join('\n'),
    ).toContain('400 steps')
  }, 120_000)

  it('#8b a scheduled turn stops at step 121', async () => {
    let calls = 0
    const t = await makeTree((request, { rootId }) => {
      if (request.sessionId !== rootId) return { text: 'x' }
      calls += 1
      return calls <= 200
        ? {
            tools: [
              { id: `todo-${calls}`, name: 'todo_write', args: { todos: [] } },
            ],
          }
        : { text: 'done looping' }
    })
    const outcome = await t.host.runBackgroundTurn(
      t.host.scopeFor(t.rootId),
      'scheduled loop',
      { source: 'scheduler', interactionPolicy: 'auto-reject' },
    )
    expect(t.adapter.requests).toHaveLength(120)
    expect(lastTurnEnd(t.events())).toEqual({
      kind: 'budget',
      limit: 'steps',
      maxSteps: 120,
    })
    expect(outcome.result).toMatchObject({
      kind: 'blocked',
      reason: 'step-limit',
    })
  }, 60_000)
})

describe('KRN-03 task tree: notices and goals', () => {
  it('#10 the model learns that the user stopped a background job', async () => {
    const root = script([
      {
        tools: [
          {
            id: 'sleep',
            name: 'bash',
            args: {
              command: 'sleep 30',
              description: 'Sleep a while',
              run_in_background: true,
            },
          },
        ],
      },
      { text: 'started it' },
      { text: 'noted' },
    ])
    const t = await makeTree((request, { rootId }) =>
      request.sessionId === rootId ? root() : { text: 'x' },
    )
    await t.submit('run it in the background')
    const jobId = t
      .events()
      .find(
        (event): event is SessionEvent<'job/started'> =>
          event.type === 'job/started',
      )!.data.jobId
    await t.api.tasks.cancel(jobId, { sessionId: t.rootId })
    await waitFor(() =>
      t.events().some((event) => event.type === 'job/finished'),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The stop does not wake the model; it learns at its next step.
    expect(t.adapter.requests).toHaveLength(2)
    await t.submit('anything new?')
    const seen = t.adapter.requests[2]!.messages.map(messageText).join('\n')
    expect(seen).toContain(`The user stopped background job ${jobId}`)
  })

  it('#11 a goal starts no new round while a subagent runs', async () => {
    const gate = gates()
    const root = script([
      { tools: [subagent('worker')] },
      { text: 'round 1 waits for the worker' },
      { text: 'saw the worker result' },
      { text: 'round 2' },
    ])
    const t = await makeTree(async (request, { rootId }) => {
      if (request.sessionId === rootId) return root()
      await gate.wait('worker')
      return { text: 'worker done' }
    })
    const agent = t.host.agentFor(t.rootId)
    const rounds = () =>
      t
        .events()
        .flatMap((event) =>
          event.type === 'goal/round' ? [event.data.round] : [],
        )
    t.host.goals.create(agent, { objective: 'ship it', maxGoalRounds: 2 })
    await waitFor(() => t.children().length === 1)
    await waitFor(() => !t.host.isBusy(t.rootId))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rounds()).toEqual([1])
    expect(t.adapter.requests[0]!.messages.map(messageText).join('\n')).toMatch(
      /end your turn instead of sleeping or polling/,
    )

    gate.release('worker')
    await waitFor(() => rounds().length === 2, 10_000)
    const settledAt = t
      .events()
      .find((event) => event.type === 'subagent/settled')!.seq
    const round2At = t
      .events()
      .find(
        (event) => event.type === 'goal/round' && event.data.round === 2,
      )!.seq
    expect(round2At).toBeGreaterThan(settledAt)
    await t.quiet()
  })
})

describe('KRN-03 task budget settings', () => {
  it('reads and saves the budget (设置 › 高级 › 任务预算)', async () => {
    const t = await makeTree(() => ({ text: 'x' }))
    expect(t.api.tasks.budget()).toEqual({
      maxSteps: 400,
      maxBackgroundSteps: 120,
      maxActiveAgents: 8,
      maxTotalAgents: 64,
      maxNoticeWakes: 32,
    })
    const saved = await t.api.tasks.setBudget(
      { maxSteps: 50, maxNoticeWakes: 5 },
      VIEW,
    )
    expect(saved).toMatchObject({ maxSteps: 50, maxNoticeWakes: 5 })
    await expect(
      t.api.tasks.setBudget({ maxActiveAgents: 0 }, VIEW),
    ).rejects.toThrow()
    expect(t.api.tasks.budget().maxActiveAgents).toBe(8)
  })
})

describe('KRN-03 budget on one agent', () => {
  const PRICED = {
    inputUsdPerMillionTokens: 1_000,
    outputUsdPerMillionTokens: 1_000,
    cacheReadUsdPerMillionTokens: 0,
    cacheWriteUsdPerMillionTokens: 0,
  }

  it('ends the turn after the request that reached the cap; the next task starts afresh', async () => {
    // 10 input + 5 output tokens at $1000/M = $0.015 per request.
    const h = createTestHarness({
      replies: [
        { tools: [{ name: 'missing_tool' }] },
        { tools: [{ name: 'missing_tool' }] },
        { text: 'never reached' },
      ],
    })
    const agent = h.agent()
    const tree = withTaskBudget(h, agent.id, { maxCostUsd: 0.02 }, PRICED)
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'budget',
      limit: 'cost',
      capUsdNanos: 20_000_000,
      spentUsdNanos: 30_000_000,
    })
    const notice = agent.session.lastOf('user/message')!.data
    expect(notice.source).toMatchObject({
      kind: 'context',
      producer: 'task-budget',
      summary: '任务费用已达上限（$0.03 / $0.02），已停止',
    })
    // While spent, the agent is not woken; the user's next message (a new
    // task on the host) starts from zero.
    tree.beginTask()
    h.adapter.push({ text: 'fresh' })
    agent.followup(userText('again'))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
  })

  it('stops a capped task when a route has no price', async () => {
    const h = createTestHarness({
      replies: [
        { tools: [{ name: 'missing_tool' }] },
        { text: 'never reached' },
      ],
    })
    const agent = h.agent()
    withTaskBudget(h, agent.id, { maxCostUsd: 5 })
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(agent.session.lastOf('turn/end')?.data.reason).toMatchObject({
      kind: 'budget',
      limit: 'cost',
      unpricedRoutes: ['test-route'],
    })
  })

  it('keeps an idle root asleep once the task is spent, until a new task begins', async () => {
    const h = createTestHarness({
      replies: [{ text: 'spent it' }, { text: 'woken after the reset' }],
    })
    const tree = withTaskBudget(h, 'root', { maxCostUsd: 0.01 }, PRICED)
    const agent = h.agent('root', { admission: tree.gate })
    tree.setRoot(agent)
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(tree.verdict().kind).toBe('exceeded')
    // A notice (e.g. a job finishing) does not wake the spent root.
    agent.followup(userText('a late notice'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(agent.status).toBe('idle')
    expect(h.adapter.requests).toHaveLength(1)
    tree.beginTask()
    await agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
  })
})

describe('recordedDescendants', () => {
  const started = (subagentId: string) =>
    ({
      type: 'subagent/started',
      seq: 0,
      time: 0,
      data: { subagentId, description: 'x', mode: 'spawn', background: true },
    }) as unknown as SessionEvent

  it('walks every recorded generation and deletes nothing but subagent sessions', () => {
    const logs: Record<string, SessionEvent[]> = {
      'sub-a': [started('sub-c')],
      'sub-c': [started('sub-a')],
    }
    expect(
      recordedDescendants(
        [started('sub-a'), started('sub-b'), started('../escape'), started('')],
        (id) => logs[id] ?? [],
      ),
    ).toEqual(['sub-a', 'sub-c', 'sub-b'])
  })
})
