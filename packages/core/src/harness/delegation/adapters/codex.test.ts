import { expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CodexExecutorAdapter } from './codex'
import { ManagedAgentProcess } from '../process'
import { defaultExecutorConfig } from '../config'
import { delegationTestDirectory } from '../testing'
import type { CodexRpcOptions } from './codex-rpc'
import type { ExecutorOpenInput } from '../types'
function fixture() {
  const f = delegationTestDirectory(),
    runtimeRoot = join(f.root, 'runtime')
  mkdirSync(runtimeRoot)
  const input: ExecutorOpenInput = {
    delegationId: 'dlg-fixture',
    profile: { ...defaultExecutorConfig().profiles[1]!, enabled: true },
    cwd: f.root,
    environment: {
      PATH: process.env.PATH ?? '',
      HOME: runtimeRoot,
      CODEX_HOME: runtimeRoot,
    },
    runtimeRoot,
    policy: {
      mode: 'workspace-write',
      workspaceRoot: f.root,
      runtimeStateRoots: [runtimeRoot],
      privateTempRoot: runtimeRoot,
    },
    boundaryReceiptId: 'boundary',
    generation: 2,
    signal: new AbortController().signal,
  }
  const processes = new ManagedAgentProcess(),
    spawn = processes.spawn.bind(processes)
  vi.spyOn(processes, 'spawn').mockImplementation((spec) =>
    spawn({
      ...spec,
      executable: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    }),
  )
  let callbacks: CodexRpcOptions | undefined
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const respond = vi.fn(async () => undefined),
    reject = vi.fn(async () => undefined)
  const request = vi.fn(async (method: string, raw: unknown) => {
    const params = raw as Record<string, unknown>
    calls.push({ method, params })
    if (method === 'initialize') return { userAgent: 'codex/0.153.4' }
    if (method === 'thread/start' || method === 'thread/resume')
      return { thread: { id: 'thread-fixture' } }
    if (method === 'turn/start')
      return { turn: { id: 'turn-fixture', status: 'inProgress' } }
    if (method === 'turn/steer') return { turnId: 'turn-fixture' }
    return {}
  })
  const adapter = new CodexExecutorAdapter({
    processes,
    rpc: (options) => {
      callbacks = options
      return {
        request,
        notify: async (method: string, params?: unknown) => {
          calls.push({ method, params: params as Record<string, unknown> })
        },
        respond,
        reject,
        close: () => options.output.end(),
      }
    },
  })
  return {
    ...f,
    input,
    adapter,
    calls,
    request,
    respond,
    reject,
    notify: (method: string, params: Record<string, unknown>) =>
      callbacks!.onNotification!(method, params),
    serverRequest: (
      id: string,
      method: string,
      params: Record<string, unknown>,
    ) => callbacks!.onRequest!(id, method, params),
  }
}
it('handshakes before starting an isolated thread and resumes exact identity', async () => {
  const f = fixture()
  const session = await f.adapter.open(f.input)
  expect(f.calls.map((c) => c.method)).toEqual([
    'initialize',
    'initialized',
    'thread/start',
  ])
  expect(f.calls[2]!.params).toMatchObject({
    cwd: f.root,
    approvalPolicy: 'never',
    config: { 'features.code_mode_host': true, 'features.multi_agent': false },
  })
  const instructions = f.calls[2]!.params.developerInstructions as string
  expect(instructions).toContain('parent agent in Emperor Agent')
  expect(instructions).toContain('Verification')
  expect(instructions).toContain('Open items')
  expect(instructions).toContain('public final response')
  await session.close()
  const resumed = await f.adapter.open({
    ...f.input,
    resumeSessionId: 'thread-fixture',
    generation: 3,
  })
  expect(
    [...f.calls].reverse().find((c) => c.method === 'thread/resume')!.params
      .threadId,
  ).toBe('thread-fixture')
  expect(resumed.providerSessionId).toBe('thread-fixture')
  await resumed.close()
  f.cleanup()
})
it('buffers notifications arriving before turn/start response and drops stale terminal events', async () => {
  const f = fixture(),
    session = await f.adapter.open(f.input)
  f.request.mockImplementationOnce(async () => {
    f.notify('turn/completed', {
      threadId: 'thread-fixture',
      turn: { id: 'old-turn', status: 'completed' },
    })
    f.notify('item/agentMessage/delta', {
      threadId: 'thread-fixture',
      turnId: 'turn-fixture',
      delta: 'fresh',
    })
    return { turn: { id: 'turn-fixture', status: 'inProgress' } }
  })
  await session.submit({
    runId: 'dgr-current',
    messageId: 'dgm-current',
    text: 'task',
  })
  f.notify('turn/completed', {
    threadId: 'thread-fixture',
    turn: { id: 'turn-fixture', status: 'completed' },
  })
  const events = []
  for await (const event of session.events) {
    events.push(event)
    if (event.type === 'turn_finished') break
  }
  expect(events[0]?.type).toBe('turn_started')
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'text_delta', text: 'fresh' }),
  )
  await session.close()
  f.cleanup()
})
it('steer carries exact expected turn ID, while stale notifications cannot finish the current run', async () => {
  const f = fixture()
  const session = await f.adapter.open(f.input)
  await session.submit({
    runId: 'dgr-current',
    messageId: 'dgm-current',
    text: 'task',
  })
  await session.steer({
    providerTurnId: 'turn-fixture',
    messageId: 'dgm-steer',
    text: 'adjust',
  })
  expect(f.calls.find((c) => c.method === 'turn/steer')!.params).toMatchObject({
    threadId: 'thread-fixture',
    expectedTurnId: 'turn-fixture',
    clientUserMessageId: 'dgm-steer',
  })
  f.notify('turn/completed', {
    threadId: 'thread-fixture',
    turn: { id: 'old-turn', status: 'completed' },
  })
  f.notify('turn/completed', {
    threadId: 'thread-fixture',
    turn: { id: 'turn-fixture', status: 'completed' },
  })
  const events = []
  for await (const event of session.events) {
    events.push(event)
    if (event.type === 'turn_finished') break
  }
  expect(events.filter((e) => e.type === 'turn_finished').length).toBe(1)
  expect(
    events.every((e) => e.generation === 2 && e.runId === 'dgr-current'),
  ).toBe(true)
  await session.close()
  f.cleanup()
})
it('interrupt acknowledgement leaves the turn open until turn/completed', async () => {
  const f = fixture()
  const session = await f.adapter.open(f.input)
  await session.submit({
    runId: 'dgr-current',
    messageId: 'dgm-current',
    text: 'task',
  })
  await session.interrupt('turn-fixture')
  const iterator = session.events[Symbol.asyncIterator]()
  expect((await iterator.next()).value.type).toBe('turn_started')
  let done = false
  const terminal = iterator.next().then((result) => {
    done = true
    return result
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(done).toBe(false)
  f.notify('turn/completed', {
    threadId: 'thread-fixture',
    turn: { id: 'turn-fixture', status: 'interrupted' },
  })
  expect((await terminal).value.type).toBe('turn_finished')
  await session.close()
  f.cleanup()
})
it('does not accept a steer response without the pinned turn identity', async () => {
  const f = fixture(),
    session = await f.adapter.open(f.input)
  await session.submit({
    runId: 'dgr-current',
    messageId: 'dgm-current',
    text: 'task',
  })
  f.request.mockImplementationOnce(async () => ({}))
  await expect(
    session.steer({
      providerTurnId: 'turn-fixture',
      messageId: 'dgm-steer',
      text: 'adjust',
    }),
  ).rejects.toThrow('PROTOCOL_INVALID')
  await session.close()
  f.cleanup()
})
it('denies unknown server requests and answers approved question text only in the current generation', async () => {
  const f = fixture()
  const session = await f.adapter.open(f.input)
  await session.submit({
    runId: 'dgr-current',
    messageId: 'dgm-current',
    text: 'task',
  })
  await f.serverRequest('unknown', 'future/execute', {
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
  })
  expect(f.reject).toHaveBeenCalledWith(
    'unknown',
    -32601,
    expect.any(String),
    2,
  )
  await f.serverRequest('question', 'item/tool/requestUserInput', {
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    questions: [
      {
        id: 'q1',
        header: 'Choice',
        question: 'Which?',
        options: [{ label: 'Blue' }],
      },
    ],
  })
  let requestId = ''
  for await (const event of session.events) {
    if (event.type === 'question') {
      requestId = event.requestId
      break
    }
  }
  await expect(
    session.answer({
      requestId,
      generation: 1,
      kind: 'question',
      answers: { q1: 'Blue' },
    }),
  ).rejects.toThrow('STALE_RUN')
  await session.answer({
    requestId,
    generation: 2,
    kind: 'question',
    answers: { q1: 'Blue' },
  })
  expect(f.respond).toHaveBeenCalledWith(
    'question',
    { answers: { q1: { answers: ['Blue'] } } },
    2,
  )
  await session.close()
  f.cleanup()
})
