// KRN-01 (PLAN-V020, findings CORE-6 / CORE-7): the session the user is
// looking at only decides what the UI shows. A background turn never moves
// it; MCP servers, plugin hooks and cancellation follow the session they run
// in, never the one in view.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION, client, methods } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { EmperorAcpAdapter } from '../acp/adapter'
import type { GenerateOptions } from '../llm/types'
import { startMcpHttpFixture } from '../mcp/testing'
import {
  MCP_SCHEMA_URL,
  portablePackage,
  writePackage,
  type PackageFiles,
} from '../plugins/testing'
import {
  SchedulerPayload,
  SchedulerSchedule,
  schedulerPayloadSessionId,
  withSchedulerPayloadSession,
} from '../scheduler/models'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp, waitFor, type ApiFixture } from './test-helpers'

let fixture: ApiFixture | null = null
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await fixture?.api.close()
  fixture = null
  while (cleanups.length) await cleanups.pop()!()
})

/** What a renderer showing `sessionId` passes along with each call. */
function view(sessionId: string | null) {
  return { sessionId }
}

function project(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function buildSession(api: CoreApi, title: string, path: string) {
  return api.sessions.create({ title, mode: 'build', project_path: path })
}

async function installInProject(
  api: CoreApi,
  sessionId: string,
  name: string,
  files: PackageFiles,
): Promise<void> {
  const source = writePackage(
    join(tmp('emperor-scope-plugin-'), name),
    portablePackage(name, files),
  )
  const preview = await api.plugins.inspect({ kind: 'local', path: source })
  // Before KRN-01 a project install could only target the focused project.
  api.sessions.activate(sessionId)
  await api.plugins.install(
    { previewId: preview.previewId, digest: preview.digest, scope: 'project' },
    view(sessionId),
  )
}

/** A plugin whose one MCP server (a local fake) offers one tool. */
async function mcpKit(toolName: string): Promise<PackageFiles> {
  const server = await startMcpHttpFixture({ toolName })
  cleanups.push(() => server.close())
  return {
    'mcp.json': {
      $schema: MCP_SCHEMA_URL,
      mcpServers: { srv: { type: 'streamable-http', url: server.url } },
    },
  }
}

function mcpTools(request: GenerateOptions | undefined): string[] {
  return (request?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => name.startsWith('mcp_'))
    .sort()
}

function scheduleFor(api: CoreApi, sessionId: string) {
  return api.host.kept.schedulerService.addJob({
    name: 'Nightly check',
    schedule: new SchedulerSchedule({ kind: 'every', every_ms: 3_600_000 }),
    payload: withSchedulerPayloadSession(
      new SchedulerPayload({ kind: 'agent_turn', message: 'Check the build' }),
      sessionId,
    ),
  })
}

describe('the session in view only decides what the UI shows (KRN-01)', () => {
  it('1: a scheduled turn in B leaves the user looking at A', async () => {
    fixture = await makeApi({
      replies: [{ text: 'A reply' }, { text: 'B scheduled reply' }],
    })
    const { api } = fixture
    const a = api.sessions.create({ title: 'A' })
    const b = api.sessions.create({ title: 'B' })
    api.sessions.activate(a.id)
    await api.chat.submit({ sessionId: a.id, content: 'hello A' })

    const job = scheduleFor(api, b.id)
    await api.host.kept.schedulerService.runJob(job.id, { force: true })

    const boot = await api.bootstrap()
    const shown = new Set(
      boot.runtime.events.map((event) => String(event.session_id)),
    )
    expect([...shown]).toEqual([a.id])
    expect(JSON.stringify(boot.runtime.events)).not.toContain(
      'B scheduled reply',
    )
  })

  it('2: a job created during B’s scheduled turn targets A, the session in view', async () => {
    fixture = await makeApi({ replies: [{ hang: true }] })
    const { api } = fixture
    const a = api.sessions.create({ title: 'A' })
    const b = api.sessions.create({ title: 'B' })
    api.sessions.activate(a.id)
    const job = scheduleFor(api, b.id)
    const run = api.host.kept.schedulerService.runJob(job.id, { force: true })
    await waitFor(() => api.host.isBusy(b.id))

    const created = (await invokeCoreOperation(
      api,
      'scheduler.createJob',
      [
        {
          name: 'Later',
          schedule: { kind: 'every', everyMs: 3_600_000 },
          payload: { kind: 'agent_turn', message: 'Look again later' },
        },
      ],
      { view: view(a.id) },
    )) as { job: { id: string } }

    const saved = api.host.kept.schedulerService.getJob(created.job.id)!
    expect(schedulerPayloadSessionId(saved.payload)).toBe(a.id)
    api.host.stop(b.id)
    await run
  })

  it('3: a project plugin’s hook does not run in a Chat session', async () => {
    const bash = (id: string) => [
      {
        tools: [
          {
            id,
            name: 'bash',
            args: { command: `echo ${id}`, description: 'Print a word' },
          },
        ],
      },
      { text: 'done' },
    ]
    fixture = await makeApi({ replies: [...bash('c1'), ...bash('a1')] })
    const { api, stateRoot } = fixture
    const projectA = project('scope-hook-a-')
    const a = buildSession(api, 'A', projectA)
    await installInProject(api, a.id, 'hook-kit', {
      'hooks/hooks.json': {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: 'echo fired >> "$PLUGIN_DATA/hook.log"',
                },
              ],
            },
          ],
        },
      },
    })
    const log = join(stateRoot, 'plugins', 'data', 'hook-kit', 'hook.log')

    const chat = api.sessions.create({ title: 'Chat' })
    await api.chat.submit({ sessionId: chat.id, content: 'run it' })
    expect(existsSync(log)).toBe(false)

    // The same hook does run in the project's own session.
    await api.chat.submit({ sessionId: a.id, content: 'run it' })
    expect(readFileSync(log, 'utf8')).toBe('fired\n')
  })

  it('4: A’s session does not see the tools of B’s project MCP instance', async () => {
    fixture = await makeApi({ replies: [{ text: 'A done' }] })
    const { api, adapter } = fixture
    const a = buildSession(api, 'A', project('scope-mcp-a-'))
    const b = buildSession(api, 'B', project('scope-mcp-b-'))
    await installInProject(api, a.id, 'alpha-kit', await mcpKit('alpha'))
    await installInProject(api, b.id, 'beta-kit', await mcpKit('beta'))
    // The user looks at B while A runs.
    api.sessions.activate(b.id)
    await api.pluginActivation.settled()

    await api.chat.submit({ sessionId: a.id, content: 'use your tools' })

    const tools = mcpTools(
      adapter.requests.find((request) => request.sessionId === a.id),
    )
    expect(tools.some((name) => name.includes('alpha'))).toBe(true)
    expect(tools.some((name) => name.includes('beta'))).toBe(false)
  })

  it('5: cancelling without a session is refused with SESSION_REQUIRED', async () => {
    fixture = await makeApi()
    const { api } = fixture
    const a = api.sessions.create({ title: 'A' })
    api.sessions.activate(a.id)

    await expect(api.chat.stopRuntime({})).rejects.toMatchObject({
      code: 'SESSION_REQUIRED',
    })
    await expect(
      invokeCoreOperation(api, 'chat.stopRuntime', [{}]),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
    expect(() => api.processes.list({})).toThrow(
      expect.objectContaining({ code: 'SESSION_REQUIRED' }),
    )
    // Naming the session works.
    await expect(
      api.chat.stopRuntime({ sessionId: a.id }),
    ).resolves.toMatchObject({ cancelled: 0 })
  })

  it('FIX-13 · E2 · the refusal speaks to the user; the operation stays on the error', async () => {
    fixture = await makeApi()
    const { api } = fixture
    const refused = await invokeCoreOperation(api, 'control.setMode', [
      'plan',
      null,
    ]).then(
      () => null,
      (error: unknown) => error as Error & { code: string; operation: string },
    )
    expect(refused).toMatchObject({
      code: 'SESSION_REQUIRED',
      message: '请先打开一个会话再试。',
      operation: 'control.setMode',
    })
    expect(refused!.message).not.toContain('sessionId')
  })

  it('11: a subagent sees the same MCP tools as its root session', async () => {
    fixture = await makeApi({
      replies: [
        {
          tools: [
            {
              id: 'd1',
              name: 'subagent',
              args: {
                description: 'look it up',
                prompt: 'Use your tools.',
                run_in_background: false,
              },
            },
          ],
        },
        { text: 'child done' },
        { text: 'root done' },
      ],
    })
    const { api, adapter } = fixture
    const a = buildSession(api, 'A', project('scope-sub-a-'))
    const b = buildSession(api, 'B', project('scope-sub-b-'))
    await installInProject(api, a.id, 'alpha-kit', await mcpKit('alpha'))
    await installInProject(api, b.id, 'beta-kit', await mcpKit('beta'))
    api.sessions.activate(b.id)
    await api.pluginActivation.settled()

    await api.chat.submit({ sessionId: a.id, content: 'delegate' })

    const root = adapter.requests.find((request) => request.sessionId === a.id)
    const child = adapter.requests.find((request) => request.sessionId !== a.id)
    expect(child).toBeDefined()
    expect(mcpTools(root).some((name) => name.includes('alpha'))).toBe(true)
    expect(mcpTools(child)).toEqual(mcpTools(root))
  })

  it('12: an ACP session uses the project instance of its cwd', async () => {
    fixture = await makeApi({ replies: [{ text: 'pong' }] })
    const { api, adapter } = fixture
    const workspace = project('scope-acp-')
    const x = buildSession(api, 'X', workspace)
    await installInProject(api, x.id, 'alpha-kit', await mcpKit('alpha'))
    // The desktop shows a Chat session while an ACP client works in the project.
    const chat = api.sessions.create({ title: 'Chat' })
    api.sessions.activate(chat.id)
    await api.pluginActivation.settled()

    const acp = new EmperorAcpAdapter(api, { version: 'test' })
    const connection = client({ name: 'scope-acp' }).connect(acp.agentApp)
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const created = await connection.agent.request(
        methods.agent.session.new,
        { cwd: workspace, mcpServers: [] },
      )
      const response = await connection.agent.request(
        methods.agent.session.prompt,
        {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'ping' }],
        },
      )
      expect(response.stopReason).toBe('end_turn')
      const request = adapter.requests.find(
        (item) => item.sessionId === created.sessionId,
      )
      expect(mcpTools(request).some((name) => name.includes('alpha'))).toBe(
        true,
      )
    } finally {
      connection.close()
      await acp.settle()
    }
  })
})
