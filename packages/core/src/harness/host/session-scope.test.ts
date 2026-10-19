// KRN-01 (PLAN-V020, findings CORE-6 / CORE-7 / CORE-13 / CORE-22): a
// background turn runs on its own. A scheduled turn ends with a typed result
// the job record maps (Failed with the error code, Cancelled, Blocked), never
// waits on an approval nobody will answer, and gives up after 30 minutes. A
// project's MCP servers run as one instance per project, shared by its
// sessions and stopped five minutes after the last one is done with it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import type { ServerConfig } from '../../mcp/config'
import { startMcpHttpFixture, type McpHttpFixture } from '../../mcp/testing'
import {
  SchedulerPayload,
  SchedulerSchedule,
  withSchedulerPayloadSession,
} from '../../scheduler/models'
import type { SandboxBackend } from '../sandbox/backend'
import { ScriptedAdapter, testRoute, type ScriptedReply } from '../testing'
import { HarnessHost, type HarnessHostOptions } from './host'

const hosts: HarnessHost[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  while (cleanups.length) await cleanups.pop()!()
})

const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [],
  }),
}

async function makeHost(
  replies: ScriptedReply[],
  extra: Partial<HarnessHostOptions> = {},
): Promise<{ host: HarnessHost; adapter: ScriptedAdapter }> {
  const root = mkdtempSync(join(tmpdir(), 'session-scope-'))
  const adapter = new ScriptedAdapter(replies)
  const llm = new LlmClient({ adapterFor: () => adapter })
  llm.setRoutes([testRoute()], 'test-route')
  const host = await HarnessHost.create({
    root,
    stateRoot: join(root, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    sandboxBackend: passthroughBackend,
    initializeMcp: false,
    watchSkills: false,
    ...extra,
  })
  hosts.push(host)
  return { host, adapter }
}

/** Timers the test fires by hand (background turn timeout, MCP idle stop). */
function manualTimers() {
  interface Pending {
    fn: () => void
    ms: number
    cleared: boolean
  }
  const pending: Pending[] = []
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const entry: Pending = { fn, ms, cleared: false }
        pending.push(entry)
        return entry
      },
      clearTimeout: (handle: unknown): void => {
        if (handle) (handle as Pending).cleared = true
      },
    },
    armed: (ms: number): boolean =>
      pending.some((entry) => !entry.cleared && entry.ms === ms),
    fire: (ms: number): void => {
      for (const entry of pending.filter(
        (item) => !item.cleared && item.ms === ms,
      )) {
        entry.cleared = true
        entry.fn()
      }
    },
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function scheduleFor(host: HarnessHost, sessionId: string) {
  return host.kept.schedulerService.addJob({
    name: 'Nightly check',
    schedule: new SchedulerSchedule({ kind: 'every', every_ms: 3_600_000 }),
    payload: withSchedulerPayloadSession(
      new SchedulerPayload({ kind: 'agent_turn', message: 'Check the build' }),
      sessionId,
    ),
  })
}

function lastRun(host: HarnessHost, jobId: string): Record<string, unknown> {
  const record = host.kept.schedulerService
    .getJob(jobId)!
    .state.run_history.at(-1)
  return (record?.toDict() ?? {}) as unknown as Record<string, unknown>
}

describe('a scheduled turn ends with a typed result (KRN-01)', () => {
  it('6: a 401 from the model records the run as Failed with code AUTH', async () => {
    const { host } = await makeHost([
      { error: 'invalid api key', code: 'AUTH' },
    ])
    const b = host.kept.sessionStore.create('B', { mode: 'chat' })
    const job = scheduleFor(host, b.id)

    await host.kept.schedulerService.runJob(job.id, { force: true })

    expect(lastRun(host, job.id)).toMatchObject({
      status: 'error',
      errorCode: 'AUTH',
    })
  })

  it('7: a scheduled turn the user stops is recorded as Cancelled', async () => {
    const { host } = await makeHost([{ hang: true }])
    const b = host.kept.sessionStore.create('B', { mode: 'chat' })
    const job = scheduleFor(host, b.id)

    const run = host.kept.schedulerService.runJob(job.id, { force: true })
    await waitFor(() => host.isBusy(b.id))
    host.stop(b.id)
    await run

    expect(lastRun(host, job.id)).toMatchObject({ status: 'cancelled' })
  })

  it('8: an approval in a scheduled turn is rejected at once and the run is Blocked with a note', async () => {
    const { host } = await makeHost([
      {
        tools: [
          {
            id: 'esc-1',
            name: 'bash',
            args: {
              description: 'Read the deploy key',
              command: 'echo hi',
              sandbox_permissions: 'danger-full-access',
              justification: 'Need the deploy key.',
            },
          },
        ],
      },
      { text: 'Could not run it without approval.' },
    ])
    const b = host.kept.sessionStore.create('B', { mode: 'chat' })
    const job = scheduleFor(host, b.id)

    const run = host.kept.schedulerService.runJob(job.id, { force: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      run,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('the scheduled turn waited on the approval')),
          4000,
        )
      }),
    ]).finally(() => clearTimeout(timer))

    expect(host.pending.hasPending(b.id)).toBe(false)
    const record = lastRun(host, job.id)
    expect(record).toMatchObject({ status: 'blocked' })
    expect(String(record.error)).toContain('自动拒绝')
  })

  it('9: a scheduled turn past 30 minutes is aborted by timeout and the job can run again', async () => {
    const clock = manualTimers()
    const { host } = await makeHost([{ hang: true }, { text: 'second run' }], {
      timers: clock.timers,
    })
    const b = host.kept.sessionStore.create('B', { mode: 'chat' })
    const job = scheduleFor(host, b.id)

    const run = host.kept.schedulerService.runJob(job.id, { force: true })
    await waitFor(() => host.isBusy(b.id))
    expect(clock.armed(30 * 60_000)).toBe(true)
    clock.fire(30 * 60_000)
    await run

    const record = lastRun(host, job.id)
    expect(record).toMatchObject({ status: 'cancelled' })
    expect(String(record.error)).toMatch(/30 分钟|timeout/i)
    // The run left the in-flight set: the next run is admitted and completes.
    await expect(
      host.kept.schedulerService.runJob(job.id, { force: true }),
    ).resolves.toBe(true)
    expect(lastRun(host, job.id)).toMatchObject({ status: 'ok' })
  })
})

describe('project MCP instances (KRN-01)', () => {
  async function fixture(toolName: string): Promise<McpHttpFixture> {
    const server = await startMcpHttpFixture({ toolName })
    cleanups.push(() => server.close())
    return server
  }

  function remote(key: string, url: string): ServerConfig {
    return {
      name: key,
      transport: 'http',
      enabled: true,
      command: null,
      args: [],
      env: {},
      url,
      headers: {},
      tool_overrides: {},
    }
  }

  it('10: two sessions of one project share one instance; it stops 5 minutes after the last one is done', async () => {
    const server = await fixture('lookup')
    const clock = manualTimers()
    const { host, adapter } = await makeHost([{ hang: true }, { hang: true }], {
      timers: clock.timers,
    })
    const project = resolve(mkdtempSync(join(tmpdir(), 'scope-project-')))
    host.projectMcp.setServerResolver((projectRoot) =>
      projectRoot === project
        ? [
            {
              key: 'kit-docs',
              pluginId: 'kit',
              serverName: 'docs',
              config: remote('kit-docs', server.url),
            },
          ]
        : [],
    )
    const build = { mode: 'build', project: { project_path: project } }
    const s1 = host.kept.sessionStore.create('S1', build)
    const s2 = host.kept.sessionStore.create('S2', build)

    void host.submit({ sessionId: s1.id, content: 'one' })
    void host.submit({ sessionId: s2.id, content: 'two' })
    await waitFor(() => adapter.requests.length === 2)

    const sees = adapter.requests.map((request) =>
      (request.tools ?? []).some((tool) => tool.name === 'mcp_kit-docs_lookup'),
    )
    expect(sees).toEqual([true, true])
    expect(host.projectMcp.snapshot()).toEqual([
      expect.objectContaining({ projectRoot: project, holders: 2 }),
    ])

    host.stop(s1.id)
    await waitFor(() => !host.isBusy(s1.id))
    expect(host.projectMcp.snapshot()).toEqual([
      expect.objectContaining({ projectRoot: project, holders: 1 }),
    ])
    expect(clock.armed(5 * 60_000)).toBe(false)

    host.stop(s2.id)
    await waitFor(() => !host.isBusy(s2.id))
    expect(host.projectMcp.snapshot()).toEqual([
      expect.objectContaining({ projectRoot: project, holders: 0 }),
    ])
    expect(clock.armed(5 * 60_000)).toBe(true)

    clock.fire(5 * 60_000)
    await waitFor(() => host.projectMcp.snapshot().length === 0)
    expect(host.tools.names()).not.toContain('mcp_kit-docs_lookup')
  })
})
