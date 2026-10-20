// KRN-10 6: the scheduler starts once plugins are synced, so a run it
// catches up on at launch already has the plugins' Hooks; a failed start is
// caught and kept for 诊断.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmClient } from '../llm/client'
import type { SandboxBackend } from '../harness/sandbox/backend'
import { ScriptedAdapter, testRoute } from '../harness/testing'
import { PluginActivationController } from '../plugins/activation'
import { SchedulerService } from '../scheduler/service'
import { CoreApi } from './core-api'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: [],
    runnerFailureRules: [],
  }),
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function createApi(stateRoot = temp('emperor-sched-start-state-')) {
  const llm = new LlmClient({ adapterFor: () => new ScriptedAdapter([]) })
  llm.setRoutes([testRoute()], 'test-route')
  return await CoreApi.create({
    root: temp('emperor-sched-start-root-'),
    stateRoot,
    stateRootSource: 'explicit',
    templatesDir: TEMPLATES_DIR,
    llm,
    sandboxBackend: passthroughBackend,
    initializeMcp: false,
    watchSkills: false,
  })
}

let api: CoreApi | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await api?.close()
  api = null
})

describe('scheduler startup (KRN-10)', () => {
  it('starts the scheduler only after plugins are synced (6)', async () => {
    const order: string[] = []
    const sync = PluginActivationController.prototype.sync
    vi.spyOn(PluginActivationController.prototype, 'sync').mockImplementation(
      async function (this: PluginActivationController) {
        await sync.call(this)
        order.push('plugins')
      },
    )
    const start = SchedulerService.prototype.start
    vi.spyOn(SchedulerService.prototype, 'start').mockImplementation(
      async function (this: SchedulerService) {
        order.push('scheduler')
        await start.call(this)
      },
    )
    api = await createApi()
    expect(order.indexOf('plugins')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('scheduler')).toBeGreaterThan(order.indexOf('plugins'))
    expect(api.scheduler.get().status).toMatchObject({
      running: true,
      startError: null,
    })
  })

  it('keeps going when the scheduler cannot start, and says why (1)', async () => {
    const stateRoot = temp('emperor-sched-start-state-')
    api = await createApi(stateRoot)
    const lockFile = join(stateRoot, 'scheduler', 'scheduler.lock')
    await api.close()
    // A live process (this test's parent) holds the lock.
    writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.ppid, startedAt: 0 }),
      'utf8',
    )
    api = await createApi(stateRoot)
    const { status } = api.scheduler.get()
    expect(status.running).toBe(false)
    expect(status.startError).toContain(String(process.ppid))
    // 诊断 shows it too.
    const diagnostics = (await api.diagnostics.get({
      sessionId: null,
    })) as unknown as { scheduler: { startError: string | null } }
    expect(diagnostics.scheduler.startError).toContain(String(process.ppid))
  })
})
