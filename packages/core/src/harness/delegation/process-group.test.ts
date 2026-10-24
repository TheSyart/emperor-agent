/**
 * AGT-04: an external run is stopped as one process group (interrupt, five
 * seconds, SIGTERM, five seconds, SIGKILL). There is no 10 Hz process scan
 * and no proof that every descendant went quiet; the native scanner only
 * runs in diagnostics mode.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ManagedAgentProcess,
  cleanBoundaryMarkers,
  readJsonLines,
  terminateRecordedProcess,
  type ManagedProcessHandle,
  type ProcessRow,
} from './process'
import { delegationTestDirectory } from './testing'
import type { ProcessOwnership } from './ownership'
import type { SandboxExecutionPolicy } from '../sandbox/policy'
import { systemBootMarker } from '../../util/stable-process-identity'
import { setCoreLogSink, type LogLine } from '../../util/log'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))
function workspace() {
  const d = delegationTestDirectory()
  cleanup.push(d.cleanup)
  const root = join(d.root, 'workspace')
  mkdirSync(root)
  const policy: SandboxExecutionPolicy = {
    mode: 'danger-full-access',
    workspaceRoot: root,
  }
  return { ...d, workspace: root, policy }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
function groupAlive(pgid: number): boolean {
  return alive(-pgid)
}
function killGroup(pgid: number | undefined | null) {
  if (!pgid) return
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}
/** `ps lstart` in the C locale, the identity Emperor records. */
function birth(pid: number): string {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
    .trim()
    .replace(/\s+/g, ' ')
}
function sleeper(detached = true): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached,
    stdio: 'ignore',
  })
  cleanup.push(() => killGroup(child.pid))
  return child
}
async function untilGone(pgid: number, limitMs: number): Promise<number> {
  const started = Date.now()
  while (groupAlive(pgid) && Date.now() - started < limitMs)
    await new Promise((r) => setTimeout(r, 25))
  return Date.now() - started
}
const IGNORE =
  'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'
/** A root and a same-group child, both ignoring SIGINT and SIGTERM. */
const STUBBORN_TREE =
  IGNORE +
  'const c=require("child_process").spawn(process.execPath,["-e",' +
  JSON.stringify(IGNORE) +
  '],{stdio:"ignore"});console.log(JSON.stringify({ready:true,child:c.pid}))'

describe.skipIf(process.platform === 'win32')('process group stop', () => {
  it('gives the group five seconds after SIGTERM, then SIGKILL (terminate)', async () => {
    const f = workspace()
    const h = await new ManagedAgentProcess().open({
      executable: process.execPath,
      args: ['-e', STUBBORN_TREE],
      cwd: f.workspace,
      env: process.env,
      policy: f.policy,
    })
    const pgid = h.identity.pid!
    cleanup.push(() => killGroup(pgid))
    let child = 0
    for await (const row of readJsonLines(h.stdout)) {
      child = Number(row.child)
      break
    }
    expect(alive(child)).toBe(true)
    void h.terminate()
    const elapsed = await untilGone(pgid, 8000)
    // SIGTERM is ignored; SIGKILL arrives at the five second mark.
    expect(elapsed).toBeGreaterThanOrEqual(4500)
    expect(elapsed).toBeLessThan(6500)
    expect(alive(child)).toBe(false)
    expect(await h.closed).toMatchObject({ quiescent: true })
  }, 15_000)

  it('ends the whole group within ten seconds of an interrupt', async () => {
    const f = workspace()
    const h = await new ManagedAgentProcess().open({
      executable: process.execPath,
      args: ['-e', STUBBORN_TREE],
      cwd: f.workspace,
      env: process.env,
      policy: f.policy,
    })
    const pgid = h.identity.pid!
    cleanup.push(() => killGroup(pgid))
    let child = 0
    for await (const row of readJsonLines(h.stdout)) {
      child = Number(row.child)
      break
    }
    void h.interrupt()
    const elapsed = await untilGone(pgid, 14_000)
    // interrupt, five seconds, SIGTERM, five seconds, SIGKILL.
    expect(elapsed).toBeGreaterThanOrEqual(9500)
    // Ten seconds plus timer drift on a busy machine.
    expect(elapsed).toBeLessThan(11_500)
    expect(alive(child)).toBe(false)
    expect(await h.closed).toMatchObject({ quiescent: true })
  }, 20_000)

  it('stops group members left behind when the root exits on its own', async () => {
    const f = workspace()
    const code =
      'const c=require("child_process").spawn(process.execPath,["-e",' +
      JSON.stringify(IGNORE) +
      '],{stdio:"ignore"});console.log(JSON.stringify({child:c.pid}));setTimeout(()=>process.exit(0),100)'
    const h = await new ManagedAgentProcess({ stopGraceMs: 300 }).open({
      executable: process.execPath,
      args: ['-e', code],
      cwd: f.workspace,
      env: process.env,
      policy: f.policy,
    })
    const pgid = h.identity.pid!
    cleanup.push(() => killGroup(pgid))
    let child = 0
    for await (const row of readJsonLines(h.stdout)) {
      child = Number(row.child)
      break
    }
    const exit = await h.closed
    expect(exit).toMatchObject({ exitCode: 0, quiescent: true })
    expect(alive(child)).toBe(false)
  })

  it('does not poll the process table while a run is working', async () => {
    const f = workspace(),
      table = vi.fn(async () => new Map())
    const h = await new ManagedAgentProcess({
      observeProcesses: table,
      stopGraceMs: 300,
    }).open({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: f.workspace,
      env: process.env,
      policy: f.policy,
    })
    cleanup.push(() => killGroup(h.identity.pid))
    await new Promise((r) => setTimeout(r, 650))
    expect(table).not.toHaveBeenCalled()
    await h.terminate()
    expect((await h.closed).quiescent).toBe(true)
  })

  it('writes no boundary markers and needs no scanner outside diagnostics mode', async () => {
    const f = workspace()
    const h = await new ManagedAgentProcess({ stopGraceMs: 300 }).open({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: f.workspace,
      env: process.env,
      policy: f.policy,
    })
    cleanup.push(() => killGroup(h.identity.pid))
    expect('boundary' in h.identity).toBe(false)
    await h.terminate()
  })
})

const EPERM = () =>
  Object.assign(new Error('kill EPERM'), {
    code: 'EPERM',
    errno: -1,
    syscall: 'kill',
  })
/**
 * Once the run's root has exited, answer group signals the way macOS does
 * in a given state of what is left of the group:
 * - 'eperm': only zombies remain (or members Emperor may not signal); every
 *   signal to the group, 0 included, fails with EPERM;
 * - 'answers': a member still answers; the signal is accepted (and dropped);
 * - 'real': the real answer.
 * `sinceExitMs` counts from the first group signal after the root's exit.
 */
function groupAnswers(
  h: ManagedProcessHandle,
  answer: (sinceExitMs: number) => 'eperm' | 'answers' | 'real',
) {
  const real = process.kill.bind(process)
  let exitedAt: number | undefined
  const spy = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid: number, signal?: string | number) => {
      const exited = h.child.exitCode !== null || h.child.signalCode !== null
      if (pid === -h.identity.pid! && exited) {
        exitedAt ??= Date.now()
        const mode = answer(Date.now() - exitedAt)
        if (mode === 'eperm') throw EPERM()
        if (mode === 'answers') return true
      }
      return real(pid, signal)
    })
  // Before the group cleanup, which must reach the real process.kill.
  cleanup.unshift(() => spy.mockRestore())
}
function member(pgid: number, state: string): Map<number, ProcessRow> {
  const pid = pgid + 1
  return new Map([
    [
      pid,
      { pid, parent: 1, group: pgid, state, birth: 'Mon Jan 1 00:00:00 2001' },
    ],
  ])
}
async function stubbornRun(
  f: ReturnType<typeof workspace>,
  options: ConstructorParameters<typeof ManagedAgentProcess>[0] = {},
) {
  const h = await new ManagedAgentProcess({
    stopGraceMs: 300,
    ...options,
  }).open({
    executable: process.execPath,
    args: ['-e', STUBBORN_TREE],
    cwd: f.workspace,
    env: process.env,
    policy: f.policy,
  })
  const pgid = h.identity.pid!
  cleanup.push(() => killGroup(pgid))
  let child = 0
  for await (const row of readJsonLines(h.stdout)) {
    child = Number(row.child)
    break
  }
  return { h, pgid, child }
}

describe.skipIf(process.platform === 'win32')(
  'the stop verdict after SIGKILL (BUG-09)',
  () => {
    const lines: LogLine[] = []
    afterEach(() => {
      setCoreLogSink(null)
      lines.length = 0
    })

    it('a group that only has a zombie left (macOS answers EPERM) has stopped', async () => {
      const f = workspace()
      const { h, child } = await stubbornRun(f)
      // The child is a zombie until launchd reaps it, 200 ms after the root.
      groupAnswers(h, (since) => (since < 200 ? 'eperm' : 'real'))
      void h.terminate()
      const exit = await h.closed
      expect(exit).toMatchObject({ quiescent: true })
      expect(exit.failureCode).toBeUndefined()
      expect(alive(child)).toBe(false)
    })

    it('a root that exits on its own with only a zombie left behind has stopped', async () => {
      const f = workspace()
      const code =
        'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},20)"],{stdio:"ignore"});setTimeout(()=>process.exit(0),150)'
      const h = await new ManagedAgentProcess({ stopGraceMs: 300 }).open({
        executable: process.execPath,
        args: ['-e', code],
        cwd: f.workspace,
        env: process.env,
        policy: f.policy,
      })
      cleanup.push(() => killGroup(h.identity.pid))
      groupAnswers(h, (since) => (since < 200 ? 'eperm' : 'real'))
      const exit = await h.closed
      expect(exit).toMatchObject({ exitCode: 0, quiescent: true })
      expect(exit.failureCode).toBeUndefined()
    })

    it('a member Emperor may not signal and that is still running has not stopped', async () => {
      const f = workspace()
      let pgid = 0
      const run = await stubbornRun(f, {
        observeProcesses: async () => member(pgid, 'S'),
      })
      pgid = run.pgid
      groupAnswers(run.h, () => 'eperm')
      void run.h.terminate()
      expect(await run.h.closed).toMatchObject({
        quiescent: false,
        failureCode: 'OUTCOME_UNKNOWN',
      })
    })

    it('reads the table again when it cannot be read, and trusts a later read', async () => {
      const f = workspace()
      let pgid = 0
      const reads: Array<Map<number, ProcessRow> | null> = []
      const table = vi.fn(async () => {
        const next = reads.length === 0 ? null : member(pgid, 'Z')
        reads.push(next)
        return next
      })
      const run = await stubbornRun(f, { observeProcesses: table })
      pgid = run.pgid
      groupAnswers(run.h, () => 'answers')
      void run.h.terminate()
      expect(await run.h.closed).toMatchObject({ quiescent: true })
      expect(table).toHaveBeenCalledTimes(2)
    })

    it('stays unconfirmed when the table cannot be read three times, and says so in the log', async () => {
      setCoreLogSink((line) => lines.push(line))
      const f = workspace()
      const table = vi.fn(async () => null)
      const { h } = await stubbornRun(f, { observeProcesses: table })
      groupAnswers(h, () => 'answers')
      void h.terminate()
      expect(await h.closed).toMatchObject({
        quiescent: false,
        failureCode: 'OUTCOME_UNKNOWN',
      })
      expect(table).toHaveBeenCalledTimes(3)
      expect(
        lines.some(
          (line) => line.level === 'warn' && line.msg.includes('ps 不可用'),
        ),
      ).toBe(true)
    })

    it('counts a member that is exiting (ps state E) as stopped', async () => {
      const f = workspace()
      let pgid = 0
      const run = await stubbornRun(f, {
        observeProcesses: async () => member(pgid, 'RE'),
      })
      pgid = run.pgid
      groupAnswers(run.h, () => 'answers')
      void run.h.terminate()
      expect(await run.h.closed).toMatchObject({ quiescent: true })
    })

    it('a member in any other state has not stopped', async () => {
      const f = workspace()
      let pgid = 0
      const table = vi.fn(async () => member(pgid, 'S'))
      const run = await stubbornRun(f, { observeProcesses: table })
      pgid = run.pgid
      groupAnswers(run.h, () => 'answers')
      void run.h.terminate()
      expect(await run.h.closed).toMatchObject({
        quiescent: false,
        failureCode: 'OUTCOME_UNKNOWN',
      })
      expect(table).toHaveBeenCalledTimes(1)
    })
  },
)

describe.skipIf(process.platform === 'win32')(
  'recorded process identity',
  () => {
    it('reads process birth and the process table in a Chinese locale', async () => {
      const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
      process.env.LC_ALL = 'zh_CN.UTF-8'
      process.env.LANG = 'zh_CN.UTF-8'
      const f = workspace()
      let pid: number | null = null
      try {
        const h = await new ManagedAgentProcess().open({
          executable: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          cwd: f.workspace,
          env: process.env,
          policy: f.policy,
        })
        pid = h.identity.pid
        cleanup.push(() => killGroup(pid))
        // Always the C format: "Mon Oct 19 11:11:43 2026".
        expect(h.identity.fingerprint).toMatch(
          /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d \d{4}$/,
        )
        const owned: ProcessOwnership = {
          schemaVersion: 1,
          ...h.identity,
          delegationId: 'dlg-zh',
          runId: 'dgr-zh',
          generation: 1,
          boundaryReceiptId: 'dgb-zh',
          policyDigest: 'fixture',
          cwd: f.workspace,
          platform: process.platform,
          descendants: [],
        }
        const exit = await terminateRecordedProcess(owned, { graceMs: 300 })
        // The live recorded process is found and stopped, not misread as gone.
        expect(alive(pid!)).toBe(false)
        expect(exit.quiescent).toBe(true)
        await h.closed
      } finally {
        for (const [key, value] of Object.entries(saved))
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
      }
    })

    it('never signals a reused PID or the children of a reused descendant PID', async () => {
      // An unrelated "user" process with a child, holding PIDs the record names.
      const code =
        'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)'
      const user = spawn(process.execPath, ['-e', code], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      cleanup.push(() => killGroup(user.pid))
      const userChild = await new Promise<number>((resolve) =>
        user.stdout!.once('data', (chunk: Buffer) =>
          resolve(Number(String(chunk).trim())),
        ),
      )
      const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      await new Promise((r) => gone.once('exit', r))
      const base: ProcessOwnership = {
        schemaVersion: 1,
        pid: gone.pid!,
        startedAt: 0,
        fingerprint: 'Mon Jan 1 00:00:00 2001',
        bootTime: systemBootMarker() ?? undefined,
        delegationId: 'dlg-reuse',
        runId: 'dgr-reuse',
        generation: 1,
        boundaryReceiptId: 'dgb-reuse',
        policyDigest: 'fixture',
        cwd: process.cwd(),
        platform: process.platform,
        // A descendant recorded by an older build; its PID now belongs to the
        // unrelated process, whose birth differs.
        descendants: [
          { pid: user.pid!, fingerprint: 'Mon Jan 1 00:00:01 2001' },
        ],
      }
      await terminateRecordedProcess(base, { graceMs: 300 })
      expect(alive(user.pid!)).toBe(true)
      expect(alive(userChild)).toBe(true)
      const reusedRoot = await terminateRecordedProcess(
        { ...base, pid: user.pid!, descendants: [] },
        { graceMs: 300 },
      )
      expect(reusedRoot).toMatchObject({
        quiescent: false,
        failureCode: 'OWNER_MISMATCH',
      })
      expect(alive(user.pid!)).toBe(true)
      expect(alive(userChild)).toBe(true)
    })

    it('stops a recorded group whose SIGKILL is answered with EPERM because only zombies were left (BUG-09)', async () => {
      const root = spawn(process.execPath, ['-e', IGNORE], {
        detached: true,
        stdio: 'ignore',
      })
      const pgid = root.pid!
      cleanup.push(() => killGroup(pgid))
      await new Promise((r) => setTimeout(r, 200))
      const real = process.kill.bind(process)
      const spy = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid: number, signal?: string | number) => {
          if (pid !== -pgid || signal !== 'SIGKILL') return real(pid, signal)
          // The group goes, and macOS answers for the zombie left behind.
          real(pid, signal)
          throw EPERM()
        })
      cleanup.unshift(() => spy.mockRestore())
      const exit = await terminateRecordedProcess(
        {
          schemaVersion: 1,
          pid: pgid,
          startedAt: 0,
          fingerprint: birth(pgid),
          bootTime: systemBootMarker() ?? undefined,
          delegationId: 'dlg-eperm',
          runId: 'dgr-eperm',
          generation: 1,
          boundaryReceiptId: 'dgb-eperm',
          policyDigest: 'fixture',
          cwd: process.cwd(),
          platform: process.platform,
          descendants: [],
        },
        { graceMs: 300 },
      )
      expect(exit).toMatchObject({ quiescent: true })
      expect(exit.failureCode).toBeUndefined()
      expect(await untilGone(pgid, 2000)).toBeLessThan(2000)
    })

    it('does not touch a recorded PID from before a system restart', async () => {
      const child = sleeper()
      const exit = await terminateRecordedProcess(
        {
          schemaVersion: 1,
          pid: child.pid!,
          startedAt: 0,
          fingerprint: birth(child.pid!),
          bootTime: 'boot-before-restart',
          delegationId: 'dlg-boot',
          runId: 'dgr-boot',
          generation: 1,
          boundaryReceiptId: 'dgb-boot',
          policyDigest: 'fixture',
          cwd: process.cwd(),
          platform: process.platform,
          descendants: [],
        },
        { bootTime: 'boot-after-restart', graceMs: 300 },
      )
      expect(exit.quiescent).toBe(true)
      expect(alive(child.pid!)).toBe(true)
    })
  },
)

describe('boundary markers', () => {
  it('removes markers older than one day and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emperor-markers-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const tag = (n: number) =>
      `0000000${n}-aaaa-bbbb-cccc-0123456789ab`.slice(-36)
    const old = [
      `emperor-boundary-${tag(1)}-denied`,
      `emperor-boundary-${tag(1)}-allowed`,
    ]
    const recent = [`emperor-boundary-${tag(2)}-denied`]
    const unrelated = ['emperor-boundary-notes.txt', 'other-file']
    for (const name of [...old, ...recent, ...unrelated])
      writeFileSync(join(dir, name), 'x')
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000
    for (const name of [...old, unrelated[0]!])
      utimesSync(join(dir, name), twoDaysAgo, twoDaysAgo)
    expect(cleanBoundaryMarkers({ dir })).toBe(2)
    expect(readdirSync(dir).sort()).toEqual([...recent, ...unrelated].sort())
  })
})
