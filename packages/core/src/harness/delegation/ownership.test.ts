import { expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import {
  ManagedAgentProcess,
  readJsonLines,
  terminateRecordedProcess,
} from './process'
import { delegationTestDirectory } from './testing'
import {
  loadOwnership,
  saveOwnership,
  type ProcessOwnership,
} from './ownership'
it.skipIf(process.platform === 'win32')(
  'persists a real process identity and confirms an independently recovered stop',
  async () => {
    const f = delegationTestDirectory(),
      workspace = join(f.root, 'workspace')
    mkdirSync(workspace)
    let owned: ProcessOwnership | undefined
    const h = await new ManagedAgentProcess().open({
      executable: process.execPath,
      args: [
        '-e',
        'console.log("{\\"ready\\":true}");setInterval(()=>{},1000)',
      ],
      cwd: workspace,
      env: process.env,
      policy: { mode: 'danger-full-access', workspaceRoot: workspace },
      onSpawn: async (identity) => {
        owned = {
          schemaVersion: 1,
          ...identity,
          delegationId: 'dlg-x',
          runId: 'dgr-x',
          generation: 1,
          boundaryReceiptId: 'dgb-x',
          policyDigest: 'fixture',
          cwd: workspace,
          platform: process.platform,
          descendants: [],
        }
        saveOwnership(f.root, owned)
      },
      onExit: (exit) => {
        if (owned) saveOwnership(f.root, { ...owned, exit })
      },
    })
    try {
      for await (const row of readJsonLines(h.stdout)) {
        expect(row.ready).toBe(true)
        break
      }
      const restored = loadOwnership(f.root, 'dgr-x')
      expect(restored.pid).toBe(h.identity.pid)
      expect(restored.fingerprint).not.toBe('')
      const recoveredExit = await terminateRecordedProcess(restored)
      expect(recoveredExit, JSON.stringify(recoveredExit)).toMatchObject({
        quiescent: true,
      })
      expect((await h.closed).quiescent).toBe(true)
      expect(await terminateRecordedProcess(restored)).toMatchObject({
        quiescent: true,
      })
      expect(loadOwnership(f.root, 'dgr-x').exit?.quiescent).toBe(true)
    } finally {
      await h.terminate().catch(() => {})
      f.cleanup()
    }
  },
)
it('does not signal a reused or unverifiable PID', async () => {
  const owned: ProcessOwnership = {
    schemaVersion: 1,
    pid: process.pid,
    startedAt: 0,
    fingerprint: 'different start identity',
    platform: process.platform,
    delegationId: 'dlg-x',
    runId: 'dgr-x',
    generation: 1,
    boundaryReceiptId: 'dgb-x',
    policyDigest: 'fixture',
    cwd: process.cwd(),
    descendants: [],
  }
  expect((await terminateRecordedProcess(owned)).quiescent).toBe(false)
})
it.skipIf(process.platform === 'win32')(
  'rejects ownership persistence failures before the caller can submit inference',
  async () => {
    const f = delegationTestDirectory(),
      late = join(f.root, 'late')
    await expect(
      new ManagedAgentProcess().open({
        executable: process.execPath,
        args: [
          '-e',
          'setTimeout(()=>require("fs").writeFileSync(process.argv[1],"leaked"),500)',
          late,
        ],
        cwd: f.root,
        env: process.env,
        policy: { mode: 'danger-full-access', workspaceRoot: f.root },
        onSpawn: async () => {
          throw new Error('durable ownership write failed')
        },
      }),
    ).rejects.toThrow('durable ownership write failed')
    await new Promise((r) => setTimeout(r, 700))
    expect(existsSync(late)).toBe(false)
    f.cleanup()
  },
)
it.skipIf(process.platform !== 'darwin')(
  'diagnostics mode: recovery finds a detached descendant by its boundary and prevents its delayed write',
  async () => {
    const f = delegationTestDirectory(),
      late = join(f.root, 'delayed-artifact')
    const nested =
      'console.log(JSON.stringify({ready:true,child:process.pid}));setTimeout(()=>{require("fs").writeFileSync(process.argv[1],"escaped");process.exit(0)},1200)'
    const code =
      'require("child_process").spawn(process.execPath,["-e",' +
      JSON.stringify(nested) +
      ',process.argv[1]],{detached:true,stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)'
    const h = await new ManagedAgentProcess({ diagnostics: () => true }).open({
      executable: process.execPath,
      args: ['-e', code, late],
      cwd: f.root,
      env: process.env,
      policy: { mode: 'danger-full-access', workspaceRoot: f.root },
      onSpawn: async (identity) => {
        saveOwnership(f.root, {
          schemaVersion: 1,
          ...identity,
          delegationId: 'dlg-detached',
          runId: 'dgr-detached',
          generation: 1,
          boundaryReceiptId: 'dgb-detached',
          policyDigest: 'fixture',
          cwd: f.root,
          platform: process.platform,
          descendants: [],
        })
      },
    })
    let childPid = 0
    try {
      for await (const row of readJsonLines(h.stdout)) {
        childPid = Number(row.child)
        break
      }
      const persisted = loadOwnership(f.root, 'dgr-detached')
      expect(persisted.boundary).toBeDefined()
      expect((await terminateRecordedProcess(persisted)).quiescent).toBe(true)
      await h.closed
      await new Promise((r) => setTimeout(r, 1400))
      expect(existsSync(late)).toBe(false)
    } finally {
      try {
        if (childPid) process.kill(childPid, 'SIGKILL')
      } catch {
        /* stopped */
      }
      await h.terminate().catch(() => {})
      f.cleanup()
    }
  },
)
