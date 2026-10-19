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
} from './process'
import { delegationTestDirectory } from './testing'
import type { ProcessOwnership } from './ownership'
import type { SandboxExecutionPolicy } from '../sandbox/policy'
import { systemBootMarker } from '../../util/stable-process-identity'

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
    expect(elapsed).toBeLessThan(11_000)
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
