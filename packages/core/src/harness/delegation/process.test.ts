import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedAgentProcess, readJsonLines } from './process'
import { LocalSandbox } from '../sandbox/backend'
import { delegationTestDirectory } from './testing'
import type { SandboxExecutionPolicy } from '../sandbox/policy'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))
function fixture() {
  const d = delegationTestDirectory()
  cleanup.push(d.cleanup)
  const workspace = join(d.root, 'workspace'),
    runtime = join(d.root, 'runtime'),
    temp = join(d.root, 'temp')
  for (const p of [workspace, runtime, temp]) mkdirSync(p)
  const policy: SandboxExecutionPolicy = {
    mode: 'workspace-write',
    workspaceRoot: workspace,
    runtimeStateRoots: [runtime],
    privateTempRoot: temp,
  }
  return { ...d, workspace, runtime, temp, policy }
}
describe('managed streaming agent process', () => {
  it.skipIf(process.platform === 'win32')(
    'stops an owned descendant that created a separate process group',
    async () => {
      const f = fixture(),
        late = join(f.workspace, 'detached-late')
      const nested =
        'console.log(JSON.stringify({pid:process.pid}));setTimeout(()=>{require("fs").writeFileSync(process.argv[1],"escaped");process.exit(0)},1500)'
      const code =
        'require("child_process").spawn(process.execPath,["-e",' +
        JSON.stringify(nested) +
        ',process.argv[1]],{detached:true,stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)'
      const h = await new ManagedAgentProcess().open({
        executable: process.execPath,
        args: ['-e', code, late],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, mode: 'danger-full-access' },
      })
      let nestedPid = 0
      for await (const row of readJsonLines(h.stdout)) {
        nestedPid = Number(row.pid)
        break
      }
      try {
        await h.terminate()
        await new Promise((resolve) => setTimeout(resolve, 1700))
        expect(existsSync(late)).toBe(false)
        expect((await h.closed).quiescent).toBe(true)
      } finally {
        try {
          process.kill(nestedPid, 'SIGKILL')
        } catch {
          /* already stopped */
        }
      }
    },
  )
  it('does not expose malformed protocol contents through parser errors', async () => {
    const consume = async () => {
      for await (const _row of readJsonLines(
        Readable.from(['{"token":"fixture-secret",broken}\n']),
      )) {
        /* consume */
      }
    }
    try {
      await consume()
      expect.fail('malformed JSON must fail')
    } catch (error) {
      expect(String(error)).not.toContain('fixture-secret')
      expect(String(error)).toContain('PROTOCOL_INVALID')
    }
  })
  it.skipIf(process.platform === 'win32')(
    'refreshes an in-flight observation after process exit before proving quiescence',
    async () => {
      const f = fixture()
      let resolveScan!: (
        rows: Map<
          number,
          {
            pid: number
            parent: number
            group: number
            state: string
            birth: string
          }
        >,
      ) => void
      let scans = 0
      const pending = new Promise<
        Map<
          number,
          {
            pid: number
            parent: number
            group: number
            state: string
            birth: string
          }
        >
      >((resolve) => {
        resolveScan = resolve
      })
      const manager = new ManagedAgentProcess({
        observeProcesses: async () => (++scans === 1 ? pending : new Map()),
      })
      const h = await manager.open({
        executable: process.execPath,
        args: [
          '-e',
          'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))',
        ],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, mode: 'danger-full-access' },
      })
      const capture = h.captureDescendants()
      h.stdin.end()
      await new Promise<void>((resolve) =>
        h.child.once('exit', () => resolve()),
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      const pid = h.identity.pid!
      resolveScan(
        new Map([
          [
            pid,
            {
              pid,
              parent: process.pid,
              group: pid,
              state: 'S',
              birth: h.identity.fingerprint,
            },
          ],
        ]),
      )
      await capture
      expect(await h.closed).toMatchObject({ exitCode: 0, quiescent: true })
      expect(scans).toBeGreaterThanOrEqual(2)
    },
  )
  it('streams stdin and stdout through a real child without collecting all output', async () => {
    const f = fixture(),
      manager = new ManagedAgentProcess()
    const handle = await manager.open({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdin.on("data",x=>process.stdout.write(x));process.stdin.on("end",()=>process.exit(0))',
      ],
      cwd: f.workspace,
      env: process.env,
      policy: { ...f.policy, mode: 'danger-full-access' },
    })
    const output = (async () => {
      const rows = []
      for await (const row of readJsonLines(handle.stdout)) rows.push(row)
      return rows
    })()
    handle.stdin.end('{"answer":42}\n')
    expect(await output).toEqual([{ answer: 42 }])
    expect(await handle.closed).toMatchObject({ exitCode: 0, quiescent: true })
  })
  it.skipIf(process.platform !== 'darwin')(
    'permits runtime state while denying outside and Git-common writes',
    async () => {
      const f = fixture(),
        outside = join(f.root, 'outside.txt'),
        git = join(f.workspace, '.git')
      mkdirSync(git)
      writeFileSync(join(git, 'config'), 'original')
      const code =
        'const fs=require("fs");let r={};for(const [k,p]of Object.entries(JSON.parse(process.argv[1])))try{fs.writeFileSync(p,"changed");r[k]=true}catch{r[k]=false}console.log(JSON.stringify(r))'
      const handle = await new ManagedAgentProcess().open({
        executable: process.execPath,
        args: [
          '-e',
          code,
          JSON.stringify({
            runtime: join(f.runtime, 'state'),
            workspace: join(f.workspace, 'ok'),
            outside,
            git: join(git, 'config'),
          }),
        ],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, readOnlyRoots: [git] },
      })
      const rows = []
      for await (const row of readJsonLines(handle.stdout)) rows.push(row)
      expect(rows).toEqual([
        { runtime: true, workspace: true, outside: false, git: false },
      ])
      expect(await handle.closed).toMatchObject({ quiescent: true })
      expect(readFileSync(join(git, 'config'), 'utf8')).toBe('original')
    },
  )
  it.skipIf(process.platform !== 'darwin')(
    'allows private runtime writes but keeps read-only content unchanged',
    async () => {
      const f = fixture(),
        target = join(f.workspace, 'source')
      writeFileSync(target, 'original')
      const code =
        'const fs=require("fs");let denied=false;try{fs.writeFileSync(process.argv[1],"bad")}catch{denied=true}fs.writeFileSync(process.argv[2],"state");console.log(JSON.stringify({denied}))'
      const h = await new ManagedAgentProcess().open({
        executable: process.execPath,
        args: ['-e', code, target, join(f.runtime, 'state')],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, mode: 'read-only' },
      })
      const rows = []
      for await (const row of readJsonLines(h.stdout)) rows.push(row)
      expect(rows).toEqual([{ denied: true }])
      expect(readFileSync(target, 'utf8')).toBe('original')
      expect((await h.closed).quiescent).toBe(true)
    },
  )
  it('decodes UTF-8 and JSON frames split at arbitrary byte boundaries', async () => {
    const bytes = Buffer.from('{"text":"中文"}\n')
    const stream = Readable.from([...bytes].map((b) => Buffer.from([b])))
    const rows = []
    for await (const row of readJsonLines(stream)) rows.push(row)
    expect(rows).toEqual([{ text: '中文' }])
  })
  it('bounds stderr floods while retaining a successful terminal response', async () => {
    const f = fixture(),
      h = await new ManagedAgentProcess().open({
        executable: process.execPath,
        args: [
          '-e',
          'process.stderr.write("x".repeat(2*1024*1024));console.log("{\\"done\\":true}")',
        ],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, mode: 'danger-full-access' },
      })
    const rows = []
    for await (const row of readJsonLines(h.stdout)) rows.push(row)
    expect(rows).toEqual([{ done: true }])
    expect((await h.closed).exitCode).toBe(0)
    expect(Buffer.byteLength(h.diagnostics())).toBeLessThanOrEqual(64 * 1024)
  })
  it('fails closed before spawning when containment is unavailable', async () => {
    const f = fixture(),
      manager = new ManagedAgentProcess({
        sandbox: new LocalSandbox({ platform: 'win32' }),
      })
    await expect(
      manager.open({
        executable: process.execPath,
        args: ['-e', 'throw Error("must not run")'],
        cwd: f.workspace,
        env: process.env,
        policy: f.policy,
      }),
    ).rejects.toThrow(/CONTAINMENT_UNAVAILABLE/)
  })
  it('stops a process which emits an oversized protocol frame', async () => {
    const f = fixture(),
      h = await new ManagedAgentProcess().open({
        executable: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({text:"x".repeat(4096)}));setInterval(()=>{},1000)',
        ],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, mode: 'danger-full-access' },
        maxFrameBytes: 64,
      })
    h.stdout.on('error', () => {})
    expect(await h.closed).toMatchObject({
      failureCode: 'OUTPUT_LIMIT',
      quiescent: true,
    })
  })
  it.skipIf(process.platform === 'win32')(
    'cancels the owned process group and confirms descendants stop writing',
    async () => {
      const f = fixture(),
        marker = join(f.workspace, 'late-write')
      const code =
        'const{spawn}=require("child_process");spawn(process.execPath,["-e",' +
        JSON.stringify(
          'setTimeout(()=>require("fs").writeFileSync(' +
            JSON.stringify(marker) +
            ',"bad"),1000);setInterval(()=>{},1000)',
        ) +
        '],{stdio:"ignore"});console.log("{\\"ready\\":true}");setInterval(()=>{},1000)'
      const h = await new ManagedAgentProcess().open({
        executable: process.execPath,
        args: ['-e', code],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, mode: 'danger-full-access' },
      })
      for await (const _row of readJsonLines(h.stdout)) {
        break
      }
      await h.terminate()
      expect((await h.closed).quiescent).toBe(true)
      await new Promise((r) => setTimeout(r, 1100))
      expect(existsSync(marker)).toBe(false)
    },
  )
  it('refuses to signal when process identity verification fails', async () => {
    const f = fixture(),
      h = await new ManagedAgentProcess({ identityMatches: () => false }).open({
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, mode: 'danger-full-access' },
      })
    try {
      await expect(h.terminate()).rejects.toThrow(/OUTCOME_UNKNOWN/)
      expect(h.child.killed).toBe(false)
    } finally {
      h.child.kill('SIGKILL')
      await h.closed
    }
  })
  it.skipIf(process.platform === 'win32')(
    'escalates until a descendant ignoring graceful signals is stopped',
    async () => {
      const f = fixture()
      const descendant =
        'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});console.log(JSON.stringify({ready:true,pid:process.pid}));setInterval(()=>{},1000)'
      const code =
        'require("child_process").spawn(process.execPath,["-e",' +
        JSON.stringify(descendant) +
        '],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)'
      const h = await new ManagedAgentProcess().open({
        executable: process.execPath,
        args: ['-e', code],
        cwd: f.workspace,
        env: process.env,
        policy: { ...f.policy, mode: 'danger-full-access' },
      })
      let descendantPid = 0
      for await (const row of readJsonLines(h.stdout)) {
        descendantPid = Number(row.pid)
        break
      }
      try {
        await h.interrupt()
        expect((await h.closed).quiescent).toBe(true)
      } finally {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          /* already stopped */
        }
      }
    },
  )
  it.skipIf(process.platform !== 'darwin')(
    'finds a fast double-fork writer after its parent exited and session changed',
    async () => {
      const f = fixture(),
        marker = join(f.workspace, 'double-fork-late')
      const python = '/opt/homebrew/bin/python3'
      const code = `import os,time,pathlib
if os.fork()==0:
 os.setsid()
 if os.fork()==0:
  time.sleep(1)
  pathlib.Path(${JSON.stringify(marker)}).write_text('escaped')
 os._exit(0)
os.wait()
time.sleep(.3)
`
      const h = await new ManagedAgentProcess().open({
        executable: python,
        args: ['-c', code],
        cwd: f.workspace,
        env: process.env,
        policy: f.policy,
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      await h.terminate()
      const result = await h.closed
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(result.quiescent).toBe(true)
      expect(existsSync(marker)).toBe(false)
    },
  )
})
