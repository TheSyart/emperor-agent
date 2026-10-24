/**
 * AGT-13: 设置 › 子智能体's version check and one-click upgrade, end to end
 * against a fake npm prefix: Claude Code and Codex installed with npm in a
 * temp folder, a fake `npm` that rewrites their package.json, and the real
 * probe (`--version`) afterwards. Never the real npm, brew, claude or codex.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexProtocol } from './compatibility'
import { defaultExecutorConfig } from './config'
import { ExecutorDispatchGate } from './dispatch-gate'
import { EXECUTOR_HEALTH_FILE, ExecutorHealthStore } from './executor-health'
import { PublishedVersionStore } from './published-versions'
import { ExecutorRegistry } from './registry'
import { fixture as delegationFixture, spec } from './service-test-fixture'
import { delegationTestDirectory, fakeClaude, fakeNpmPrefix } from './testing'
import type {
  ExecutorProbe,
  ExecutorUpgradeView,
  ExternalBackend,
} from './types'
import { ExecutorUpgradeService } from './upgrade-service'

const cleanup: Array<() => void> = []
/** Processes start and end slowly while the whole suite runs. */
const LOADED = { timeout: 10_000 }
afterEach(() => cleanup.splice(0).forEach((f) => f()))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Both CLIs installed with a (fake) npm in a temp prefix (testing.ts). */
function machine(versions?: Parameters<typeof fakeNpmPrefix>[1]) {
  const d = delegationTestDirectory()
  const root = realpathSync(d.root)
  cleanup.push(() => {
    try {
      chmodSync(join(root, 'prefix/lib/node_modules'), 0o755)
    } catch {
      /* not changed */
    }
    d.cleanup()
  })
  return { root, ...fakeNpmPrefix(root, versions) }
}

function service(
  m: ReturnType<typeof machine>,
  options: {
    protocols?: readonly CodexProtocol[]
    activeRuns?: (backend: ExternalBackend) => number
    automatic?: boolean
    fetch?: () => Promise<void>
    now?: () => number
    /** What each version did (VER-03). */
    health?: ExecutorHealthStore
    /** npm's latest Claude Code (default 2.1.308). */
    claudeLatest?: string
    /** Folders before /usr/bin:/bin (default: the npm prefix's bin). */
    path?: string
  } = {},
) {
  const config = defaultExecutorConfig()
  for (const p of config.profiles) p.enabled = true
  const environment = {
    PATH: `${options.path ?? `${m.prefix}/bin`}:/usr/bin:/bin`,
  }
  const registry = new ExecutorRegistry({ home: m.root, environment })
  const probes = new Map<string, ExecutorProbe>()
  const profileOf = (id: string) => config.profiles.find((p) => p.id === id)!
  const fetches: string[] = []
  const published = new PublishedVersionStore({
    root: m.root,
    now: options.now ?? (() => Date.now()),
    fetch: async (pkg) => {
      fetches.push(pkg)
      await options.fetch?.()
      return pkg === '@openai/codex'
        ? {
            latest: '0.163.0',
            versions: ['0.153.0', '0.153.4', '0.160.0', '0.163.0'],
          }
        : {
            latest: options.claudeLatest ?? '2.1.308',
            versions: [options.claudeLatest ?? '2.1.308'],
          }
    },
  })
  const events: Array<Record<string, unknown>> = []
  const gate = new ExecutorDispatchGate()
  const upgrades = new ExecutorUpgradeService({
    root: m.root,
    home: m.root,
    profiles: () => config.profiles,
    locate: (profile) => registry.locate(profile),
    lastProbe: (profile) => probes.get(profile.id) ?? null,
    probe: async (profileId) => {
      const probe = await registry.probe(profileOf(profileId))
      probes.set(profileId, probe)
      return probe
    },
    environment: () => environment,
    claudeConfigDir: () => join(m.root, 'delegations/claude-code/config'),
    published,
    codexProtocols:
      options.protocols ??
      ([{ version: '0.153.4', files: [], digests: [] }] as CodexProtocol[]),
    activeRuns: options.activeRuns ?? (() => 0),
    gate,
    emit: (event) => events.push(event),
    automatic: options.automatic ?? false,
    pollMs: 20,
    graceMs: 200,
    startupDelayMs: 0,
    ...(options.now ? { now: options.now } : {}),
    ...(options.health ? { health: options.health } : {}),
  })
  cleanup.push(() => void upgrades.close())
  const probeAll = async () => {
    for (const p of config.profiles) await upgrades.options.probe(p.id)
  }
  return { upgrades, events, gate, fetches, probes, config, probeAll }
}

const both = [
  { version: '0.153.4', files: [], digests: [] },
  { version: '0.163.0', files: [], digests: [] },
] as CodexProtocol[]

async function settled(
  events: Array<Record<string, unknown>>,
  profileId: string,
): Promise<ExecutorUpgradeView> {
  let found: ExecutorUpgradeView | undefined
  await vi.waitFor(
    () => {
      found = events
        .filter((e) => e.event === 'executor_upgrade' && e.upgrade)
        .map((e) => e.upgrade as ExecutorUpgradeView)
        .find(
          (u) =>
            u.profileId === profileId &&
            ['succeeded', 'failed', 'cancelled'].includes(u.state),
        )
      expect(found).toBeDefined()
    },
    { timeout: 10_000 },
  )
  return found!
}

describe('executor versions', () => {
  it('reports the installed version, how it was installed, the latest and what 升级 installs', async () => {
    const m = machine()
    const s = service(m)
    await s.probeAll()
    const view = await s.upgrades.versions({ refresh: true })
    expect(view.error).toBeNull()
    expect(view.checkedAt).not.toBeNull()
    const claude = view.executors.find((e) => e.backend === 'claude-code')!
    const codex = view.executors.find((e) => e.backend === 'codex')!
    expect(claude).toMatchObject({
      profileId: 'claude-default',
      installed: '2.1.281',
      install: {
        kind: 'npm',
        location: join(m.prefix, 'lib/node_modules/@anthropic-ai/claude-code'),
      },
      latest: '2.1.308',
      target: '2.1.308',
      unverified: null,
      upgrade: {
        oneClick: true,
        command: 'npm install -g @anthropic-ai/claude-code@2.1.308',
      },
      activeRuns: 0,
    })
    // Codex 0.163 is not verified (only 0.153 is): reported, not offered.
    expect(codex).toMatchObject({
      installed: '0.153.4',
      latest: '0.163.0',
      verified: ['0.153'],
      target: null,
      unverified: '0.163.0',
      upgrade: null,
    })
    expect(view.dismissed).toBe(false)
    expect(view.upgrades).toEqual([])
  })

  it('offers Codex 0.163 as soon as Emperor verifies it', async () => {
    const m = machine()
    const s = service(m, { protocols: both })
    await s.probeAll()
    const codex = (await s.upgrades.versions({ refresh: true })).executors.find(
      (e) => e.backend === 'codex',
    )!
    expect(codex).toMatchObject({
      verified: ['0.153', '0.163'],
      target: '0.163.0',
      unverified: null,
      upgrade: {
        oneClick: true,
        command: 'npm install -g @openai/codex@0.163.0',
      },
    })
  })

  it('checks when asked, at most once a minute when the page opens', async () => {
    const m = machine()
    let now = 1_000_000
    const s = service(m, { now: () => now })
    await s.upgrades.versions({ refresh: 'auto' })
    await s.upgrades.versions({ refresh: 'auto' })
    expect(s.fetches).toHaveLength(2)
    now += 61_000
    await s.upgrades.versions({ refresh: 'auto' })
    expect(s.fetches).toHaveLength(4)
    await s.upgrades.versions({ refresh: true })
    expect(s.fetches).toHaveLength(6)
    await s.upgrades.versions()
    expect(s.fetches).toHaveLength(6)
    expect(s.events.some((e) => e.versions)).toBe(true)
  })

  it('checks once at startup when the last check is a day old, only where checks may run', async () => {
    const m = machine()
    const quiet = service(m, { automatic: false })
    quiet.upgrades.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(quiet.fetches).toEqual([])
    const s = service(m, { automatic: true })
    s.upgrades.start()
    await vi.waitFor(() => expect(s.fetches).toHaveLength(2), LOADED)
    // Checked today: the next start does not ask again.
    const again = service(m, { automatic: true })
    again.upgrades.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(again.fetches).toEqual([])
  })

  it('稍后 hides the notice for these versions, until a newer one comes', async () => {
    const m = machine()
    const s = service(m)
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    expect((await s.upgrades.dismiss()).dismissed).toBe(true)
    const reopened = service(m)
    await reopened.probeAll()
    expect((await reopened.upgrades.versions()).dismissed).toBe(true)
    // After Emperor verifies 0.163, Codex has something new to offer.
    const newer = service(m, { protocols: both })
    await newer.probeAll()
    expect((await newer.upgrades.versions()).dismissed).toBe(false)
  })
})

describe('one-click upgrade', () => {
  it('runs that prefix’s npm, then probes again and shows the new version', async () => {
    const m = machine()
    const s = service(m)
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    const { upgrade } = await s.upgrades.upgrade({
      profileId: 'claude-default',
      target: '2.1.308',
    })
    expect(upgrade).toMatchObject({
      backend: 'claude-code',
      from: '2.1.281',
      target: '2.1.308',
      command: 'npm install -g @anthropic-ai/claude-code@2.1.308',
    })
    expect(['waiting', 'running']).toContain(upgrade.state)
    const done = await settled(s.events, 'claude-default')
    expect(done).toMatchObject({ state: 'succeeded', installed: '2.1.308' })
    expect(done.log[0]).toBe(
      '$ npm install -g @anthropic-ai/claude-code@2.1.308',
    )
    expect(done.log.join('\n')).toContain('changed 1 package')
    expect(done.log.join('\n')).toContain('正在重新检测 Claude Code…')
    const last = s.events
      .filter((e) => e.event === 'executor_upgrade' && e.upgrade)
      .at(-1)!
    expect((last.probe as ExecutorProbe).executableVersion).toBe('2.1.308')
    expect(s.probes.get('claude-default')?.executableVersion).toBe('2.1.308')
    const view = await s.upgrades.versions()
    expect(
      view.executors.find((e) => e.backend === 'claude-code'),
    ).toMatchObject({ installed: '2.1.308', target: null })
    expect(
      view.upgrades.find((u) => u.profileId === 'claude-default')?.state,
    ).toBe('succeeded')
    expect(
      readFileSync(join(m.root, 'npm-calls'), 'utf8').trim().split('\n'),
    ).toEqual(['install -g @anthropic-ai/claude-code@2.1.308'])
    // Nothing was written into the user's ~/.claude or ~/.codex.
    expect(existsSync(join(m.root, '.claude'))).toBe(false)
    expect(existsSync(join(m.root, '.codex'))).toBe(false)
  })

  it('upgrades Codex to the verified 0.163.0 and nothing else', async () => {
    const m = machine()
    const unverified = service(m)
    await unverified.probeAll()
    await unverified.upgrades.versions({ refresh: true })
    await expect(
      unverified.upgrades.upgrade({
        profileId: 'codex-default',
        target: '0.163.0',
      }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_UPGRADE_UNAVAILABLE' })
    const s = service(m, { protocols: both })
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    await expect(
      s.upgrades.upgrade({ profileId: 'codex-default', target: '0.160.0' }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_UPGRADE_UNAVAILABLE' })
    await s.upgrades.upgrade({ profileId: 'codex-default', target: '0.163.0' })
    expect(await settled(s.events, 'codex-default')).toMatchObject({
      state: 'succeeded',
      installed: '0.163.0',
    })
  })

  it('without write permission: why, the folder and the command to copy (EACCES from npm)', async () => {
    const m = machine()
    m.mode('eacces')
    const s = service(m, { protocols: both })
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    await s.upgrades.upgrade({ profileId: 'codex-default', target: '0.163.0' })
    const failed = await settled(s.events, 'codex-default')
    expect(failed).toMatchObject({
      state: 'failed',
      reason: 'permission',
      path: join(m.prefix, 'lib/node_modules'),
      manualCommand: 'npm install -g @openai/codex@0.163.0',
      exitCode: 243,
    })
    expect(failed.log.join('\n')).toContain('EACCES')
    // Still the old version, and Codex takes subtasks again.
    expect(s.probes.get('codex-default')?.executableVersion).toBe('0.153.4')
    expect(s.gate.refused('codex')).toBeUndefined()
  })

  it('a folder it cannot write fails before npm runs', async () => {
    const m = machine()
    chmodSync(join(m.prefix, 'lib/node_modules'), 0o555)
    const s = service(m)
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    await s.upgrades.upgrade({ profileId: 'claude-default', target: '2.1.308' })
    expect(await settled(s.events, 'claude-default')).toMatchObject({
      state: 'failed',
      reason: 'permission',
      path: join(m.prefix, 'lib/node_modules'),
      manualCommand: 'npm install -g @anthropic-ai/claude-code@2.1.308',
    })
    expect(existsSync(join(m.root, 'npm-calls'))).toBe(false)
  })

  it('exit 0 but the version did not change is a failure', async () => {
    const m = machine()
    m.mode('noop')
    const s = service(m)
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    await s.upgrades.upgrade({ profileId: 'claude-default', target: '2.1.308' })
    expect(await settled(s.events, 'claude-default')).toMatchObject({
      state: 'failed',
      reason: 'not-upgraded',
      installed: '2.1.281',
    })
  })

  it('取消 kills npm and what it started; the version stays', async () => {
    const m = machine()
    m.mode('hang')
    const s = service(m)
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    await s.upgrades.upgrade({ profileId: 'claude-default', target: '2.1.308' })
    await vi.waitFor(
      () => expect(existsSync(join(m.root, 'npm-pids'))).toBe(true),
      LOADED,
    )
    const pids = readFileSync(join(m.root, 'npm-pids'), 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number)
    expect(pids.every(alive)).toBe(true)
    const { upgrade } = await s.upgrades.cancel({ profileId: 'claude-default' })
    expect(upgrade?.state).toBe('cancelled')
    await vi.waitFor(() => expect(pids.some(alive)).toBe(false), LOADED)
    expect(await settled(s.events, 'claude-default')).toMatchObject({
      state: 'cancelled',
    })
    expect(s.probes.get('claude-default')?.executableVersion).toBe('2.1.281')
  })

  it('one upgrade at a time per executor: a second click joins the first', async () => {
    const m = machine()
    m.mode('hang')
    const s = service(m)
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    const first = await s.upgrades.upgrade({
      profileId: 'claude-default',
      target: '2.1.308',
    })
    const second = await s.upgrades.upgrade({
      profileId: 'claude-default',
      target: '2.1.308',
    })
    expect(second.upgrade.startedAt).toBe(first.upgrade.startedAt)
    await vi.waitFor(
      () => expect(existsSync(join(m.root, 'npm-pids'))).toBe(true),
      LOADED,
    )
    await s.upgrades.cancel({ profileId: 'claude-default' })
    expect(
      readFileSync(join(m.root, 'npm-calls'), 'utf8').trim().split('\n'),
    ).toHaveLength(1)
  })

  it('waits for running subtasks of that executor, taking no new ones meanwhile', async () => {
    const m = machine()
    let running = 1
    const s = service(m, {
      activeRuns: (b) => (b === 'claude-code' ? running : 0),
    })
    await s.probeAll()
    expect(
      (await s.upgrades.versions({ refresh: true })).executors.find(
        (e) => e.backend === 'claude-code',
      )?.activeRuns,
    ).toBe(1)
    const { upgrade } = await s.upgrades.upgrade({
      profileId: 'claude-default',
      target: '2.1.308',
    })
    expect(upgrade).toMatchObject({ state: 'waiting', waitingFor: 1 })
    expect(s.gate.refused('claude-code')).toMatch(/upgrad/i)
    expect(s.gate.refused('codex')).toBeUndefined()
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(join(m.root, 'npm-calls'))).toBe(false)
    running = 0
    expect(await settled(s.events, 'claude-default')).toMatchObject({
      state: 'succeeded',
    })
    expect(s.gate.refused('claude-code')).toBeUndefined()
  })

  it('取消 while waiting never runs npm', async () => {
    const m = machine()
    const s = service(m, { activeRuns: () => 1 })
    await s.probeAll()
    await s.upgrades.versions({ refresh: true })
    await s.upgrades.upgrade({ profileId: 'claude-default', target: '2.1.308' })
    expect(
      (await s.upgrades.cancel({ profileId: 'claude-default' })).upgrade?.state,
    ).toBe('cancelled')
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(join(m.root, 'npm-calls'))).toBe(false)
    expect(s.gate.refused('claude-code')).toBeUndefined()
  })
})

describe('no new delegations during an upgrade', () => {
  it('a new delegation to the executor being upgraded is refused; others are not', async () => {
    const f = delegationFixture()
    cleanup.push(f.cleanup)
    const gate = new ExecutorDispatchGate()
    // The fixture's options object is the service's own.
    f.options.dispatchGate = gate
    gate.hold('codex')
    await expect(f.service.start(f.owner, spec)).rejects.toMatchObject({
      code: 'EXECUTOR_UPGRADING',
    })
    expect(f.service.list()).toEqual([])
    gate.hold('claude-code')
    gate.release('claude-code')
    gate.release('codex')
    const record = await f.service.start(f.owner, {
      ...spec,
      clientRequestId: 'after',
    })
    expect(record.backend).toBe('codex')
    await f.service.wait(record.id, record.currentRunId!)
  })

  it('a run that starts while the command runs waits until it ends', async () => {
    const gate = new ExecutorDispatchGate()
    gate.hold('codex')
    await gate.settled('codex')
    gate.installing('codex')
    let resumed = false
    const waiting = gate.settled('codex').then(() => {
      resumed = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(resumed).toBe(false)
    gate.release('codex')
    await waiting
    expect(resumed).toBe(true)
    // Stopping the run ends its wait.
    gate.hold('codex')
    gate.installing('codex')
    const controller = new AbortController()
    const stopped = gate.settled('codex', controller.signal)
    controller.abort()
    await expect(stopped).rejects.toMatchObject({ code: 'ABORTED' })
    gate.release('codex')
  })

  it('counts the running runs of each executor', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = delegationFixture(undefined, hold)
    cleanup.push(f.cleanup)
    expect(f.service.activeRuns('codex')).toBe(0)
    const record = await f.service.start(f.owner, spec)
    expect(f.service.activeRuns('codex')).toBe(1)
    expect(f.service.activeRuns('claude-code')).toBe(0)
    release()
    await f.service.wait(record.id, record.currentRunId!)
    await vi.waitFor(
      () => expect(f.service.activeRuns('codex')).toBe(0),
      LOADED,
    )
  })
})

describe('退回 (VER-03)', () => {
  /** 2.1.281 ran a task; the installed 2.1.308 failed twice for its version. */
  function broken(m: ReturnType<typeof machine>) {
    const health = new ExecutorHealthStore(join(m.root, 'delegations'))
    health.recordSuccess('claude-default', '2.1.281', 'dgr-good')
    for (const runId of ['dgr-bad-1', 'dgr-bad-2'])
      health.recordFailure('claude-default', '2.1.308', {
        code: 'EXECUTOR_INCOMPATIBLE',
        reason: 'Claude Code 2.1.308 的内置插件关闭后仍在加载',
        runId,
      })
    return health
  }
  const healthFile = (m: ReturnType<typeof machine>) =>
    JSON.parse(
      readFileSync(join(m.root, 'delegations', EXECUTOR_HEALTH_FILE), 'utf8'),
    )

  it('3 · 6 · the row offers the last good version; 退回 runs that prefix’s npm, probes again and remembers the version it left', async () => {
    const m = machine({ 'claude-code': '2.1.308', codex: '0.153.4' })
    const s = service(m, { health: broken(m) })
    await s.probeAll()
    const before = await s.upgrades.versions({ refresh: true })
    const claude = before.executors.find((e) => e.backend === 'claude-code')!
    expect(claude).toMatchObject({
      installed: '2.1.308',
      target: null,
      rollback: {
        target: '2.1.281',
        because: '2.1.308 上 2 次任务因版本不兼容失败',
        oneClick: true,
        command: 'npm install -g @anthropic-ai/claude-code@2.1.281',
      },
    })
    expect(claude.rollback).not.toHaveProperty('manual')
    // Codex has no history: nothing to go back to.
    expect(
      before.executors.find((e) => e.backend === 'codex'),
    ).not.toHaveProperty('rollback')
    // Not an upgrade: no notice, nothing to dismiss.
    expect(before.dismissed).toBe(false)

    const { upgrade } = await s.upgrades.rollback({
      profileId: 'claude-default',
      target: '2.1.281',
    })
    expect(upgrade).toMatchObject({
      kind: 'rollback',
      backend: 'claude-code',
      from: '2.1.308',
      target: '2.1.281',
      command: 'npm install -g @anthropic-ai/claude-code@2.1.281',
    })
    const done = await settled(s.events, 'claude-default')
    expect(done).toMatchObject({
      kind: 'rollback',
      state: 'succeeded',
      installed: '2.1.281',
    })
    expect(done.log[0]).toBe(
      '$ npm install -g @anthropic-ai/claude-code@2.1.281',
    )
    expect(
      readFileSync(join(m.root, 'npm-calls'), 'utf8').trim().split('\n'),
    ).toEqual(['install -g @anthropic-ai/claude-code@2.1.281'])
    expect(s.probes.get('claude-default')?.executableVersion).toBe('2.1.281')
    expect(
      healthFile(m).profiles['claude-default'].versions['2.1.308']
        .rolledBackFrom,
    ).toEqual(expect.any(Number))
    // Back on the last good version: no rollback, and 2.1.308 is not
    // offered again as an upgrade.
    const after = (await s.upgrades.versions()).executors.find(
      (e) => e.backend === 'claude-code',
    )!
    expect(after).toMatchObject({ installed: '2.1.281', target: null })
    expect(after).not.toHaveProperty('rollback')
    expect(s.gate.refused('claude-code')).toBeUndefined()
  })

  it('5 · only the version offered: another target, or none offered, is refused before anything runs', async () => {
    const m = machine({ 'claude-code': '2.1.308', codex: '0.153.4' })
    const s = service(m, { health: broken(m) })
    await s.probeAll()
    for (const target of ['2.1.300', '2.1.308'])
      await expect(
        s.upgrades.rollback({ profileId: 'claude-default', target }),
      ).rejects.toMatchObject({ code: 'EXECUTOR_ROLLBACK_UNAVAILABLE' })
    await expect(
      s.upgrades.rollback({ profileId: 'codex-default', target: '0.153.0' }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_ROLLBACK_UNAVAILABLE' })
    await expect(
      s.upgrades.rollback({ profileId: 'nobody', target: '2.1.281' }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_NOT_FOUND' })
    // Without any history there is never a rollback.
    const fresh = service(
      machine({ 'claude-code': '2.1.308', codex: '0.153.4' }),
    )
    await fresh.probeAll()
    await expect(
      fresh.upgrades.rollback({
        profileId: 'claude-default',
        target: '2.1.281',
      }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_ROLLBACK_UNAVAILABLE' })
    expect(existsSync(join(m.root, 'npm-calls'))).toBe(false)
    expect(s.gate.refused('claude-code')).toBeUndefined()
  })

  it('7 · after a rollback 升级 skips the version it left, and offers the next newer one', async () => {
    const m = machine()
    const health = new ExecutorHealthStore(join(m.root, 'delegations'))
    health.recordSuccess('claude-default', '2.1.281', 'dgr-good')
    health.markRolledBack('claude-default', '2.1.308')
    const same = service(m, { health })
    await same.probeAll()
    expect(
      (await same.upgrades.versions({ refresh: true })).executors.find(
        (e) => e.backend === 'claude-code',
      ),
    ).toMatchObject({ installed: '2.1.281', latest: '2.1.308', target: null })
    const newer = service(m, { health, claudeLatest: '2.1.312' })
    await newer.probeAll()
    expect(
      (await newer.upgrades.versions({ refresh: true })).executors.find(
        (e) => e.backend === 'claude-code',
      ),
    ).toMatchObject({
      installed: '2.1.281',
      target: '2.1.312',
      upgrade: {
        oneClick: true,
        command: 'npm install -g @anthropic-ai/claude-code@2.1.312',
      },
    })
  })

  it('8 · Homebrew: no one click, the npm command to copy instead', async () => {
    const m = machine()
    const brew = join(m.root, 'opt-homebrew')
    fakeClaude(join(brew, 'Caskroom/claude-code/2.1.308'), {
      version: '2.1.308',
    })
    mkdirSync(join(brew, 'bin'), { recursive: true })
    symlinkSync(
      '../Caskroom/claude-code/2.1.308/claude',
      join(brew, 'bin/claude'),
    )
    const s = service(m, { health: broken(m), path: join(brew, 'bin') })
    await s.probeAll()
    const claude = (
      await s.upgrades.versions({ refresh: true })
    ).executors.find((e) => e.backend === 'claude-code')!
    expect(claude).toMatchObject({
      installed: '2.1.308',
      install: { kind: 'homebrew' },
      rollback: {
        target: '2.1.281',
        oneClick: false,
        manual: 'homebrew',
        command: 'npm install -g @anthropic-ai/claude-code@2.1.281',
      },
    })
    await expect(
      s.upgrades.rollback({ profileId: 'claude-default', target: '2.1.281' }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_ROLLBACK_UNAVAILABLE' })
    expect(existsSync(join(m.root, 'npm-calls'))).toBe(false)
  })

  it('waits for running subtasks and takes no new ones meanwhile; 取消 leaves the version as it was', async () => {
    const m = machine({ 'claude-code': '2.1.308', codex: '0.153.4' })
    const s = service(m, { health: broken(m), activeRuns: () => 1 })
    await s.probeAll()
    const { upgrade } = await s.upgrades.rollback({
      profileId: 'claude-default',
      target: '2.1.281',
    })
    expect(upgrade).toMatchObject({
      kind: 'rollback',
      state: 'waiting',
      waitingFor: 1,
    })
    expect(s.gate.refused('claude-code')).toMatch(/upgrad/i)
    // A second click (either button) joins the one going.
    expect(
      (
        await s.upgrades.upgrade({
          profileId: 'claude-default',
          target: '2.1.308',
        })
      ).upgrade.startedAt,
    ).toBe(upgrade.startedAt)
    expect(
      (await s.upgrades.cancel({ profileId: 'claude-default' })).upgrade?.state,
    ).toBe('cancelled')
    expect(existsSync(join(m.root, 'npm-calls'))).toBe(false)
    expect(s.gate.refused('claude-code')).toBeUndefined()
    expect(
      healthFile(m).profiles['claude-default'].versions['2.1.308'],
    ).not.toHaveProperty('rolledBackFrom')
  })

  it('a rollback that fails leaves the version unmarked and gives the command', async () => {
    const m = machine({ 'claude-code': '2.1.308', codex: '0.153.4' })
    m.mode('eacces')
    const s = service(m, { health: broken(m) })
    await s.probeAll()
    await s.upgrades.rollback({
      profileId: 'claude-default',
      target: '2.1.281',
    })
    expect(await settled(s.events, 'claude-default')).toMatchObject({
      kind: 'rollback',
      state: 'failed',
      reason: 'permission',
      manualCommand: 'npm install -g @anthropic-ai/claude-code@2.1.281',
    })
    expect(
      healthFile(m).profiles['claude-default'].versions['2.1.308'],
    ).not.toHaveProperty('rolledBackFrom')
    // Still offered: the user may fix the folder and try again.
    expect(
      (await s.upgrades.versions()).executors.find(
        (e) => e.backend === 'claude-code',
      )?.rollback?.target,
    ).toBe('2.1.281')
  })
})
