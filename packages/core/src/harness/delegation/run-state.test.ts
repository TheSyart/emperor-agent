/**
 * AGT-04: run state after a restart, the "mark as ended" exit, quarantine
 * without a budget slot, append-only-on-change journals, and the interrupt
 * race (SUB-5, SUB-15, SUB-29, SUB-33).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture, spec } from './service-test-fixture'
import { DelegationService } from './service'
import { DelegationJournal } from './journal'
import { saveOwnership } from './ownership'
import {
  FakeExecutorAdapter,
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from './testing'
import { TERMINAL_RUN_PHASES, type DelegationRunRecord } from './types'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import { systemBootMarker } from '../../util/stable-process-identity'
import {
  NODE_SYNC_PERSISTENCE_ADAPTER,
  type SyncPersistenceAdapter,
} from '../../store/persistence'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
function killGroup(pid: number | undefined) {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}
function birth(pid: number): string {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
    .trim()
    .replace(/\s+/g, ' ')
}
function lines(root: string, id: string): number {
  return readFileSync(
    join(root, 'conversations', id, 'journal.jsonl'),
    'utf8',
  ).split('\n').length
}
const completes = new FakeExecutorAdapter('codex', async function* (turn, o) {
  yield {
    type: 'turn_finished',
    status: 'completed',
    text: 'done',
    delegationId: o.delegationId,
    runId: turn.runId,
    generation: o.generation,
  }
})
/** A journal whose run was `running` when Emperor stopped. */
async function crashedRun(
  f: ReturnType<typeof fixture>,
  options: {
    process?: { pid: number; fingerprint: string; bootTime?: string }
    owner?: Partial<ReturnType<typeof fixtureDelegationRecord>['owner']>
    workspace?: 'shared-readonly' | 'shared-exclusive'
    phase?: DelegationRunRecord['phase']
    patch?: Partial<DelegationRunRecord>
  } = {},
) {
  const record = {
      ...fixtureDelegationRecord(),
      owner: { ...fixtureDelegationRecord().owner, ...options.owner },
      cwd: f.root,
      workspaceLeaseId: 'lease-fixture',
      startSpec: { ...spec, workspace: options.workspace ?? 'shared-readonly' },
      effectivePermission:
        options.workspace === 'shared-exclusive'
          ? ('workspace-write' as const)
          : ('read-only' as const),
    },
    journal = new DelegationJournal(f.root, record.id)
  const identity = options.process && {
    pid: options.process.pid,
    startedAt: 1,
    fingerprint: options.process.fingerprint,
    ...(options.process.bootTime ? { bootTime: options.process.bootTime } : {}),
    boundaryReceiptId: 'dgb-crash',
    policyDigest: 'policy',
  }
  await journal.append({ type: 'created', record })
  await journal.append({
    type: 'message-enqueued',
    message: { id: 'dgm-1', text: 'work', status: 'queued' },
  })
  await journal.append({ type: 'run-created', run: fixtureDelegationRun() })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: {
      phase: 'preparing',
      quotaReserved: true,
      startedAt: 1,
      ...(identity ? { process: identity } : {}),
    },
  })
  await journal.append({
    type: 'send-intent',
    runId: 'dgr-1',
    messageId: 'dgm-1',
  })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: { phase: 'running' },
  })
  if (options.phase && options.phase !== 'running')
    await journal.append({
      type: 'run-changed',
      runId: 'dgr-1',
      patch: { phase: options.phase, ...options.patch },
    })
  if (identity)
    saveOwnership(f.root, {
      schemaVersion: 1,
      ...identity,
      platform: process.platform,
      delegationId: record.id,
      runId: 'dgr-1',
      generation: 1,
      cwd: f.root,
      descendants: [],
    })
  return record
}

it('a run that was active when Emperor quit is interrupted after restart and holds no slot', async () => {
  // The turn never ends: Emperor quits while it is running.
  const f = fixture(async function* (turn, open) {
    await new Promise(() => {})
    yield {
      type: 'turn_finished',
      status: 'completed',
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
    }
  })
  cleanup.push(f.cleanup)
  const record = await f.service.start(f.owner, spec)
  await vi.waitFor(
    () =>
      expect(
        f.service.inspect(record.id).runs[record.currentRunId!]?.phase,
      ).toBe('running'),
    LOADED,
  )
  // Force quit: a new process opens the same state; the old one never stops.
  const restarted = new DelegationService({
    ...f.options,
    adapters: new Map([['codex', completes]]),
    mutations: new WorkspaceMutationCoordinator(),
  })
  await restarted.reconcile()
  const state = restarted.inspect(record.id)
  expect(state.runs[record.currentRunId!]).toMatchObject({
    phase: 'interrupted',
    quiescent: true,
    failureCode: 'APP_RESTARTED',
  })
  expect(state.record?.availability).toBe('idle')
  expect(restarted.hasOutstanding(f.owner.rootSessionId)).toBe(false)
  // The executor's only slot is free: a new task runs straight away.
  const second = await restarted.start(f.owner, {
    ...spec,
    clientRequestId: 'second',
  })
  await expect(
    restarted.wait(second.id, second.currentRunId!),
  ).resolves.toMatchObject({ phase: 'completed' })
})

it.skipIf(process.platform === 'win32')(
  'after a crash in the same boot the recorded process group is stopped and the run interrupted',
  async () => {
    const f = fixture()
    cleanup.push(f.cleanup)
    const code =
      'require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});setInterval(()=>{},1000)'
    const orphan = spawn(process.execPath, ['-e', code], {
      detached: true,
      stdio: 'ignore',
    })
    cleanup.push(() => killGroup(orphan.pid))
    await new Promise((r) => setTimeout(r, 200))
    const record = await crashedRun(f, {
      process: {
        pid: orphan.pid!,
        fingerprint: birth(orphan.pid!),
        bootTime: systemBootMarker() ?? undefined,
      },
    })
    const restarted = new DelegationService(f.options)
    await restarted.reconcile()
    expect(alive(-orphan.pid!)).toBe(false)
    const state = restarted.inspect(record.id)
    expect(state.runs['dgr-1']).toMatchObject({
      phase: 'interrupted',
      quiescent: true,
      failureCode: 'APP_RESTARTED',
    })
    // Its prompt may or may not have arrived: never resent, but it no
    // longer holds up the root or its Goal.
    expect(state.messages['dgm-1']?.status).toBe('delivery_unknown')
    expect(restarted.hasOutstanding('root')).toBe(false)
  },
)

it.skipIf(process.platform === 'win32')(
  'a run from before a system restart is interrupted without signalling its old PID',
  async () => {
    const f = fixture()
    cleanup.push(f.cleanup)
    const holder: ChildProcess = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { detached: true, stdio: 'ignore' },
    )
    cleanup.push(() => killGroup(holder.pid))
    await new Promise((r) => setTimeout(r, 200))
    const record = await crashedRun(f, {
      process: {
        pid: holder.pid!,
        fingerprint: birth(holder.pid!),
        bootTime: 'boot-before',
      },
    })
    const restarted = new DelegationService({
      ...f.options,
      bootTime: () => 'boot-after',
    })
    await restarted.reconcile()
    expect(restarted.inspect(record.id).runs['dgr-1']).toMatchObject({
      phase: 'interrupted',
      quiescent: true,
      failureCode: 'SYSTEM_RESTARTED',
    })
    expect(alive(holder.pid!)).toBe(true)
  },
)

it('marking a stuck run as ended releases its workspace and lets the Goal continue', async () => {
  const f = fixture()
  cleanup.push(f.cleanup)
  f.setParent('workspace-write')
  const goal = { id: 'g', revision: 1 }
  // Its recorded PID is alive under a different birth: it cannot be stopped
  // or proved gone, so the workspace stays quarantined.
  const record = await crashedRun(f, {
    workspace: 'shared-exclusive',
    owner: { taskScopeId: 'goal:g', goalRef: goal, requiredForGoal: true },
    process: {
      pid: process.pid,
      fingerprint: 'Mon Jan 1 00:00:00 2001',
      bootTime: systemBootMarker() ?? undefined,
    },
    phase: 'outcome_unknown',
    patch: { quiescent: false, failureCode: 'OUTPUT_LIMIT', finishedAt: 2 },
  })
  f.options.workspaces.get = () => ({
    id: 'lease-fixture',
    revision: 1,
    owner: record.owner,
    cwd: f.root,
    path: f.root,
    mode: 'shared-exclusive',
    status: 'retained',
  })
  const restarted = new DelegationService(f.options)
  await restarted.reconcile()
  expect(f.mutations.hasActiveWriter(f.root)).toBe(true)
  expect(restarted.hasOutstanding('root')).toBe(true)
  await expect(restarted.verifyGoalCompletion(goal, 'root')).rejects.toThrow(
    'REQUIRED_DELEGATION_UNVERIFIED',
  )
  await restarted.abandon(record.id, 'user')
  const state = restarted.inspect(record.id)
  expect(state.runs['dgr-1']).toMatchObject({
    phase: 'outcome_unknown',
    failureCode: 'OUTPUT_LIMIT',
    recoveryResolved: true,
    abandoned: { by: 'user' },
  })
  expect(state.record?.availability).toBe('idle')
  expect(state.messages['dgm-1']?.status).toBe('cancelled')
  expect(f.mutations.hasActiveWriter(f.root)).toBe(false)
  expect(restarted.hasOutstanding('root')).toBe(false)
  await expect(
    restarted.verifyGoalCompletion(goal, 'root'),
  ).resolves.toBeUndefined()
  // Nothing more to end.
  await expect(restarted.abandon(record.id, 'user')).rejects.toThrow(
    'NOTHING_TO_END',
  )
})

it('a queued run paused by a restart can be marked as ended', async () => {
  const f = fixture()
  cleanup.push(f.cleanup)
  const record = {
      ...fixtureDelegationRecord(),
      cwd: f.root,
      workspaceLeaseId: 'lease-fixture',
      startSpec: spec,
    },
    journal = new DelegationJournal(f.root, record.id)
  await journal.append({ type: 'created', record })
  await journal.append({
    type: 'message-enqueued',
    message: { id: 'dgm-1', text: 'queued', status: 'queued' },
  })
  await journal.append({ type: 'run-created', run: fixtureDelegationRun() })
  const restarted = new DelegationService(f.options)
  await restarted.reconcile()
  expect(restarted.hasOutstanding('root')).toBe(true)
  await restarted.abandon(record.id, 'user')
  expect(restarted.inspect(record.id).runs['dgr-1']).toMatchObject({
    phase: 'cancelled',
    abandoned: { by: 'user' },
  })
  expect(restarted.hasOutstanding('root')).toBe(false)
  expect(f.adapter.submitted).toHaveLength(0)
})

it('a quarantined run holds no budget slot: a second task on the same executor runs', async () => {
  const f = fixture()
  cleanup.push(f.cleanup)
  let first = true
  const open = f.adapter.open.bind(f.adapter)
  f.adapter.open = async (input) => {
    const session = await open(input)
    if (!first) return session
    first = false
    // The stop of the first run cannot be confirmed.
    return { ...session, close: async () => ({ quiescent: false }) }
  }
  const a = await f.service.start(f.owner, spec)
  expect(await f.service.wait(a.id, a.currentRunId!)).toMatchObject({
    phase: 'outcome_unknown',
    quiescent: false,
  })
  const b = await f.service.start(f.owner, { ...spec, clientRequestId: 'b' })
  const settled = await Promise.race([
    f.service.wait(b.id, b.currentRunId!),
    new Promise<null>((r) => setTimeout(() => r(null), 3000)),
  ])
  expect(settled).toMatchObject({ phase: 'completed' })
})

it('startup, stop and new messages leave settled history untouched', async () => {
  const f = fixture()
  cleanup.push(f.cleanup)
  const record = await f.service.start(f.owner, spec)
  await f.service.wait(record.id, record.currentRunId!)
  await f.service.stopRoot('root')
  const before = lines(f.root, record.id)
  const restarted = new DelegationService({
    ...f.options,
    mutations: new WorkspaceMutationCoordinator(),
  })
  await restarted.reconcile()
  expect(lines(f.root, record.id)).toBe(before)
  await restarted.stopRoot('root')
  await restarted.resumeRootNotices('root')
  await restarted.stopRoot('root')
  expect(lines(f.root, record.id)).toBe(before)
})

it('the delegation journal is folded in memory, not replayed on every read', async () => {
  const f = fixture()
  cleanup.push(f.cleanup)
  let reads = 0
  const adapter: SyncPersistenceAdapter = {
    ...NODE_SYNC_PERSISTENCE_ADAPTER,
    readText: (path) => {
      if (path.endsWith('journal.jsonl')) reads++
      return NODE_SYNC_PERSISTENCE_ADAPTER.readText(path)
    },
  }
  const journal = new DelegationJournal(f.root, 'dlg-test', { adapter })
  await journal.append({ type: 'created', record: fixtureDelegationRecord() })
  await journal.append({ type: 'run-created', run: fixtureDelegationRun() })
  for (let i = 0; i < 20; i++) journal.load()
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: { phase: 'preparing' },
  })
  expect(reads).toBeLessThanOrEqual(2)
  // An unchanged state is not appended again.
  const seq = journal.load().lastSeq
  await journal.append({ type: 'dispatch-paused', paused: false })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: { phase: 'preparing' },
  })
  expect(journal.load().lastSeq).toBe(seq)
})

it('a stop racing the end of a turn never makes an illegal transition (100 rounds)', async () => {
  for (let round = 0; round < 100; round++) {
    let finish!: () => void
    const f = fixture(async function* (turn, open) {
      await new Promise<void>((r) => (finish = r))
      yield {
        type: 'turn_finished',
        status: round % 3 === 0 ? 'completed' : 'failed',
        delegationId: open.delegationId,
        runId: turn.runId,
        generation: open.generation,
      }
    })
    try {
      const record = await f.service.start(f.owner, {
        ...spec,
        clientRequestId: 'race-' + round,
      })
      await vi.waitFor(
        () =>
          expect(
            f.service.inspect(record.id).runs[record.currentRunId!]?.phase,
          ).toBe('running'),
        { interval: 2, timeout: 5000 },
      )
      // The turn ends on its own; the stop lands a few microtasks later,
      // sweeping the window in which the host settles the run.
      finish()
      for (let i = 0; i < round % 25; i++) await Promise.resolve()
      const stopped =
          round % 5 === 4
            ? f.service.interrupt(record.id, record.currentRunId!)
            : f.service.stopRoot('root'),
        settled = await Promise.race([
          stopped.then(() => f.service.wait(record.id, record.currentRunId!)),
          new Promise<null>((r) => setTimeout(() => r(null), 2000)),
        ])
      const run = f.service.inspect(record.id).runs[record.currentRunId!]!
      expect(settled, `round ${round} stuck in ${run.phase}`).not.toBeNull()
      expect(TERMINAL_RUN_PHASES.has(run.phase), `round ${round}`).toBe(true)
      expect(
        f.service.inspect(record.id).record?.availability,
        `round ${round}: ${run.phase}`,
      ).not.toBe('needs_recovery')
    } finally {
      f.cleanup()
    }
  }
}, 180_000)

it('a previous failure reason survives restarts', async () => {
  const f = fixture()
  cleanup.push(f.cleanup)
  const record = await crashedRun(f, {
    phase: 'outcome_unknown',
    patch: { quiescent: false, failureCode: 'OUTPUT_LIMIT', finishedAt: 2 },
  })
  for (let i = 0; i < 2; i++) {
    const restarted = new DelegationService({
      ...f.options,
      mutations: new WorkspaceMutationCoordinator(),
    })
    await restarted.reconcile()
    expect(restarted.inspect(record.id).runs['dgr-1']?.failureCode).toBe(
      'OUTPUT_LIMIT',
    )
  }
})

it('startup removes boundary markers older than one day', async () => {
  const f = fixture()
  cleanup.push(f.cleanup)
  const dir = mkdtempSync(join(tmpdir(), 'emperor-markers-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const stale = 'emperor-boundary-00000001-aaaa-bbbb-cccc-0123456789ab-denied',
    fresh = 'emperor-boundary-00000002-aaaa-bbbb-cccc-0123456789ab-allowed'
  writeFileSync(join(dir, stale), 'x')
  writeFileSync(join(dir, fresh), 'x')
  const old = (Date.now() - 2 * 86_400_000) / 1000
  utimesSync(join(dir, stale), old, old)
  await new DelegationService({
    ...f.options,
    boundaryMarkerDir: dir,
  }).reconcile()
  expect(readdirSync(dir)).toEqual([fresh])
})
