import { expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { CodexExecutorAdapter, normalizeCodexNotification } from './codex'
import { ManagedAgentProcess } from '../process'
import { defaultExecutorConfig } from '../config'
import { delegationTestDirectory } from '../testing'
import { codexAuthLockPath, linkCodexAuth } from '../codex-auth'
import { DelegationError } from '../types'
import type { CodexRpcOptions } from './codex-rpc'
import type { ExecutorOpenInput } from '../types'
function fixture(
  userAgent = 'codex/0.153.4',
  script = 'process.stdin.resume()',
) {
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
      args: ['-e', script],
    }),
  )
  let callbacks: CodexRpcOptions | undefined
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const respond = vi.fn(async () => undefined),
    reject = vi.fn(async () => undefined)
  const holds = { active: 0, total: 0 }
  const hold = vi.fn(() => {
    holds.active++
    holds.total++
    let released = false
    return () => {
      if (released) return
      released = true
      holds.active--
    }
  })
  const request = vi.fn(async (method: string, raw: unknown) => {
    const params = raw as Record<string, unknown>
    calls.push({ method, params })
    if (method === 'initialize') return { userAgent }
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
        hold,
        close: () => options.output.end(),
      }
    },
  })
  return {
    ...f,
    input,
    adapter,
    processes,
    calls,
    request,
    respond,
    reject,
    holds,
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
  expect((await iterator.next()).value.type).toBe('runtime_metadata')
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

it('accepts a patch release of the supported minor and refuses another minor with the required range', async () => {
  const patch = fixture('codex_cli_rs/0.153.9 (Mac OS 26.4.0; arm64)')
  const session = await patch.adapter.open(patch.input)
  await session.close()
  patch.cleanup()
  const minor = fixture('codex_cli_rs/0.154.0 (Mac OS 26.4.0; arm64)')
  await expect(minor.adapter.open(minor.input)).rejects.toThrow(
    /EXECUTOR_INCOMPATIBLE.*0\.153\.x/,
  )
  minor.cleanup()
})

it('resumes without hydrating history, so a long thread cannot exceed the frame limit', async () => {
  const f = fixture()
  const session = await f.adapter.open({
    ...f.input,
    resumeSessionId: 'thread-fixture',
  })
  expect(
    f.calls.find((c) => c.method === 'thread/resume')!.params,
  ).toMatchObject({ threadId: 'thread-fixture', excludeTurns: true })
  await session.close()
  f.cleanup()
})

it('inspects history through thread/turns/list pages of at most 1 MiB', async () => {
  const f = fixture()
  const pages: Record<string, unknown>[] = []
  f.request.mockImplementation(
    async (
      method: string,
      raw: unknown,
      _signal?: unknown,
      options?: unknown,
    ) => {
      const params = raw as Record<string, unknown>
      f.calls.push({ method, params })
      if (method === 'initialize') return { userAgent: 'codex/0.153.4' }
      if (method === 'thread/resume')
        return { thread: { id: 'thread-fixture' } }
      if (method === 'thread/read')
        return { thread: { id: 'thread-fixture', status: { type: 'idle' } } }
      if (method === 'thread/turns/list') {
        pages.push({ ...params, options })
        // A page of 8 large turns would not fit in 1 MiB; the adapter halves it.
        if ((params.limit as number) > 4)
          throw new DelegationError('OUTPUT_LIMIT', 'result exceeded limit')
        // Newest first: turn-7..turn-4, then turn-3..turn-0.
        const newest = params.cursor === 'c1' ? 3 : 7
        return {
          data: Array.from({ length: 4 }, (_, i) => ({
            id: 'turn-' + (newest - i),
            status: 'completed',
            items: [{ type: 'agentMessage', text: 'answer ' + (newest - i) }],
          })),
          nextCursor: newest === 7 ? 'c1' : null,
        }
      }
      return {}
    },
  )
  const history = await f.adapter.inspect({
    ...f.input,
    resumeSessionId: 'thread-fixture',
  })
  expect(
    f.calls.some((c) => c.method === 'thread/read' && c.params.includeTurns),
  ).toBe(false)
  expect(pages.length).toBeGreaterThan(1)
  for (const page of pages)
    expect(page).toMatchObject({
      threadId: 'thread-fixture',
      sortDirection: 'desc',
      options: { maxResultBytes: 1024 * 1024 },
    })
  expect(history.nativeStatus).toBe('idle')
  // Newest first from the server, oldest first in the inspection.
  expect(history.turns.map((t) => t.id)).toEqual(
    Array.from({ length: 8 }, (_, i) => 'turn-' + i),
  )
  expect(history.turns.at(-1)!.text).toBe('answer 7')
  f.cleanup()
})

it('a running turn pauses the idle timer until the turn finishes or the session closes', async () => {
  const f = fixture()
  const session = await f.adapter.open(f.input)
  expect(f.holds.active).toBe(0)
  await session.submit({ runId: 'dgr-a', messageId: 'dgm-a', text: 'task' })
  expect(f.holds.active).toBe(1)
  f.notify('turn/completed', {
    threadId: 'thread-fixture',
    turn: { id: 'turn-fixture', status: 'completed' },
  })
  expect(f.holds.active).toBe(0)
  await session.close()
  expect(f.holds).toEqual({ active: 0, total: 1 })
  const second = await f.adapter.open(f.input)
  await second.submit({ runId: 'dgr-b', messageId: 'dgm-b', text: 'task' })
  expect(f.holds.active).toBe(1)
  await second.close()
  expect(f.holds.active).toBe(0)
  f.cleanup()
})

function authFixture(script?: string) {
  const f = fixture('codex/0.153.4', script)
  const home = join(f.root, 'fake-home', '.codex')
  mkdirSync(home, { recursive: true })
  const source = join(home, 'auth.json')
  writeFileSync(
    source,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'refresh-0', account_id: 'acct-1' },
      last_refresh: '2026-10-10T00:00:00Z',
    }),
    { mode: 0o600 },
  )
  const link = { source, isolated: join(f.input.runtimeRoot, 'auth.json') }
  linkCodexAuth(link)
  const input: ExecutorOpenInput = {
    ...f.input,
    codexAuth: link,
    policy: { ...f.input.policy, writableFiles: [realpathSync(source)] },
  }
  return { ...f, input, link }
}

it('starts app-server with file-only credential storage, never the Keychain', async () => {
  const f = authFixture()
  const spawn = vi.mocked(f.processes.spawn)
  const session = await f.adapter.open(f.input)
  const args = spawn.mock.calls[0]![0].args
  expect(args.join(' ')).toContain('cli_auth_credentials_store="file"')
  await session.close()
  f.cleanup()
})

it.skipIf(process.platform !== 'darwin')(
  'a Codex refresh written through the link reaches the user file inside the Seatbelt boundary',
  async () => {
    // The fake app-server rewrites auth.json in place, as Codex 0.153 does.
    const f = authFixture(
      `const fs=require('fs');const p=process.env.CODEX_HOME+'/auth.json';` +
        `const a=JSON.parse(fs.readFileSync(p,'utf8'));a.tokens.refresh_token='refresh-1';` +
        `a.last_refresh='2026-10-19T00:00:00Z';fs.writeFileSync(p,JSON.stringify(a));` +
        `fs.writeFileSync(process.env.CODEX_HOME+'/written','1');process.stdin.resume()`,
    )
    const session = await f.adapter.open(f.input)
    await vi.waitFor(
      () => expect(existsSync(join(f.input.runtimeRoot, 'written'))).toBe(true),
      { timeout: 5000 },
    )
    expect(existsSync(codexAuthLockPath(f.link))).toBe(true)
    await session.close()
    expect(
      JSON.parse(readFileSync(f.link.source, 'utf8')).tokens.refresh_token,
    ).toBe('refresh-1')
    expect(readlinkSync(f.link.isolated)).toBe(f.link.source)
    expect(existsSync(codexAuthLockPath(f.link))).toBe(false)
    f.cleanup()
  },
)

it.skipIf(process.platform !== 'darwin')(
  'a Codex that replaces auth.json by rename still leaves the user file current',
  async () => {
    const f = authFixture(
      `const fs=require('fs');const p=process.env.CODEX_HOME+'/auth.json';` +
        `const a=JSON.parse(fs.readFileSync(p,'utf8'));a.tokens.refresh_token='refresh-1';` +
        `a.last_refresh='2026-10-19T00:00:00Z';fs.writeFileSync(p+'.tmp',JSON.stringify(a));` +
        `fs.renameSync(p+'.tmp',p);fs.writeFileSync(process.env.CODEX_HOME+'/written','1');process.stdin.resume()`,
    )
    const session = await f.adapter.open(f.input)
    await vi.waitFor(
      () => expect(existsSync(join(f.input.runtimeRoot, 'written'))).toBe(true),
      { timeout: 5000 },
    )
    await session.close()
    expect(
      JSON.parse(readFileSync(f.link.source, 'utf8')).tokens.refresh_token,
    ).toBe('refresh-1')
    expect(lstatSync(f.link.isolated).isSymbolicLink()).toBe(true)
    f.cleanup()
  },
)

it('two Codex processes on the same login never run at the same time', async () => {
  const f = authFixture()
  const first = await f.adapter.open(f.input)
  let opened = false
  const second = f.adapter
    .open({ ...f.input, delegationId: 'dlg-second' })
    .then((session) => {
      opened = true
      return session
    })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(opened).toBe(false)
  expect(vi.mocked(f.processes.spawn)).toHaveBeenCalledTimes(1)
  await first.close()
  const session = await second
  expect(vi.mocked(f.processes.spawn)).toHaveBeenCalledTimes(2)
  await session.close()
  f.cleanup()
})

it('7 · the Codex brief carries the project’s AGENTS.md summary and the development environment (AGT-08)', async () => {
  const f = fixture()
  writeFileSync(
    join(f.root, 'AGENTS.md'),
    '# Agents\nNever touch generated/.\n',
  )
  const session = await f.adapter.open({
    ...f.input,
    environment: {
      ...f.input.environment,
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NVM_DIR: '/Users/ada/.nvm',
      HTTPS_PROXY: 'http://proxy.example:8080',
    },
  })
  const params = f.calls[2]!.params as {
    developerInstructions: string
    config: Record<string, unknown>
  }
  expect(params.developerInstructions).toContain('AGENTS.md')
  expect(params.developerInstructions).toContain('Never touch generated/.')
  expect(params.config['shell_environment_policy.set']).toMatchObject({
    GIT_AUTHOR_NAME: 'Ada Lovelace',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    NVM_DIR: '/Users/ada/.nvm',
    HTTPS_PROXY: 'http://proxy.example:8080',
  })
  await session.close()
  f.cleanup()
})

/** What the real 0.163 app-server answers to Emperor's clientInfo. */
const USER_AGENT_0163 =
  'emperor-agent/0.163.0 (Mac OS 26.4.1; arm64) unknown (emperor-agent; 0.1.0)'
async function finished(session: { events: AsyncIterable<unknown> }) {
  for await (const event of session.events as AsyncIterable<{
    type: string
    text?: string
    status?: string
    structured?: unknown
    error?: string
  }>)
    if (event.type === 'turn_finished') return event
  throw new Error('no turn_finished')
}
function agentMessage(
  f: ReturnType<typeof fixture>,
  id: string,
  text: string,
  phase?: string,
) {
  f.notify('item/completed', {
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    item: { type: 'agentMessage', id, text, ...(phase ? { phase } : {}) },
  })
}

it('AGT-13 · a 0.163 answer split into partial_answer messages reaches the parent whole, without the commentary', async () => {
  const f = fixture(USER_AGENT_0163)
  const session = await f.adapter.open(f.input)
  await session.submit({ runId: 'dgr-a', messageId: 'dgm-a', text: 'task' })
  agentMessage(f, 'm1', 'Looking at the parser first.', 'commentary')
  agentMessage(f, 'm2', 'The parser drops trailing commas.', 'partial_answer')
  f.notify('item/completed', {
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    item: { type: 'commandExecution', id: 'c1', status: 'completed' },
  })
  agentMessage(f, 'm3', 'Running the tests now.', 'commentary')
  agentMessage(f, 'm4', 'Fixed; all 42 tests pass.', 'final_answer')
  f.notify('turn/completed', {
    threadId: 'thread-fixture',
    turn: { id: 'turn-fixture', status: 'completed', items: [] },
  })
  expect(await finished(session)).toMatchObject({
    status: 'completed',
    text: 'The parser drops trailing commas.\n\nFixed; all 42 tests pass.',
  })
  await session.close()
  f.cleanup()
})

it('AGT-13 · a turn/completed that lists its items gives the same whole answer', () => {
  const message = (id: string, text: string, phase: string) => ({
    type: 'agentMessage',
    id,
    text,
    phase,
  })
  expect(
    normalizeCodexNotification('turn/completed', {
      turn: {
        id: 'turn',
        status: 'completed',
        items: [
          message('m1', 'Looking first.', 'commentary'),
          message('m2', 'Part one.', 'partial_answer'),
          message('m3', 'Part two.', 'partial_answer'),
          message('m4', 'Done.', 'final_answer'),
        ],
      },
    }),
  ).toEqual([
    {
      type: 'turn_finished',
      status: 'completed',
      text: 'Part one.\n\nPart two.\n\nDone.',
    },
  ])
})

it('AGT-13 · without partial answers (0.153, or 0.163 on most turns) the last message is the answer, as before', async () => {
  const f = fixture()
  const session = await f.adapter.open(f.input)
  await session.submit({ runId: 'dgr-a', messageId: 'dgm-a', text: 'task' })
  agentMessage(f, 'm1', 'Looking at the parser first.', 'commentary')
  agentMessage(f, 'm2', 'Fixed; all 42 tests pass.', 'final_answer')
  f.notify('turn/completed', {
    threadId: 'thread-fixture',
    turn: { id: 'turn-fixture', status: 'completed', items: [] },
  })
  expect((await finished(session)).text).toBe('Fixed; all 42 tests pass.')
  await session.close()
  f.cleanup()
  expect(
    normalizeCodexNotification('turn/completed', {
      turn: {
        id: 'turn',
        status: 'completed',
        items: [
          { type: 'agentMessage', id: 'a', text: 'first' },
          { type: 'agentMessage', id: 'b', text: 'last' },
        ],
      },
    }),
  ).toEqual([{ type: 'turn_finished', status: 'completed', text: 'last' }])
})

it('AGT-13 · a structured-output turn is parsed from its final message only', async () => {
  const f = fixture(USER_AGENT_0163)
  const session = await f.adapter.open(f.input)
  await session.submit({
    runId: 'dgr-a',
    messageId: 'dgm-a',
    text: 'task',
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  })
  agentMessage(f, 'm1', 'Checking.', 'partial_answer')
  agentMessage(f, 'm2', '{"ok":true}', 'final_answer')
  f.notify('turn/completed', {
    threadId: 'thread-fixture',
    turn: { id: 'turn-fixture', status: 'completed', items: [] },
  })
  expect(await finished(session)).toMatchObject({
    status: 'completed',
    structured: { ok: true },
  })
  await session.close()
  f.cleanup()
})

it('AGT-13 · the real 0.163 user agent passes the handshake', async () => {
  const f = fixture(USER_AGENT_0163)
  const session = await f.adapter.open(f.input)
  expect(session.providerSessionId).toBe('thread-fixture')
  await session.close()
  f.cleanup()
  for (const version of ['0.162.0', '0.164.0']) {
    const other = fixture(USER_AGENT_0163.replace('0.163.0', version))
    await expect(other.adapter.open(other.input)).rejects.toThrow(
      /EXECUTOR_INCOMPATIBLE.*0\.153\.x \/ 0\.163\.x/,
    )
    other.cleanup()
  }
})
