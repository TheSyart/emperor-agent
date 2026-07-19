import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  OwnedProcessRuntime,
  ProcessLeaseConflictError,
  type OwnedProcessReceipt,
} from './runtime'
import {
  pidIsAlive,
  stableProcessStartIdentity,
  systemBootMarker,
} from '../util/stable-process-identity'

const owner = {
  kind: 'session' as const,
  id: 'session-a',
  sessionId: 'session-a',
}

function containment(root: string) {
  return {
    mode: 'preferred' as const,
    workspaceRoot: root,
    stateRoot: null,
    tempRoot: root,
    readOnlyRoots: [] as string[],
    network: 'deny' as const,
  }
}

describe('OwnedProcessRuntime receipts', () => {
  it('persists owner, lease, cwd capability, sandbox and bounded quota without raw command data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-owned-process-'))
    const runtime = new OwnedProcessRuntime(root)
    const secret = 'must-not-be-persisted'

    const result = await runtime.run({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(secret)})`],
      cwd: root,
      env: {},
      owner,
      containment: containment(root),
      maxOutputBytes: 4_096,
    })

    expect(result).toMatchObject({ status: 'completed', stdout: secret })
    const receipts = runtime.list()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      schemaVersion: 1,
      owner,
      status: 'completed',
      outputQuota: {
        maxBytes: 4_096,
        strategy: 'terminate',
        exceeded: false,
      },
      cwdCapability: { access: 'execute', withinWorkspace: true },
      containment: { decision: expect.any(String) },
    })
    expect(receipts[0]?.lease.id).toMatch(/^process_lease_/)
    expect(receipts[0]?.commandDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(receipts[0])).not.toContain(secret)
    expect(readFileSync(runtime.receiptsPath, 'utf8')).not.toContain(secret)
  })

  it('contains stdin EPIPE when a short-lived child exits without reading input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-owned-stdin-'))
    const runtime = new OwnedProcessRuntime(root)

    const result = await runtime.run({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: root,
      env: {},
      stdin: Buffer.alloc(2 * 1_024 * 1_024, 'x'),
      owner,
      containment: containment(root),
    })
    await delay(20)

    expect(result).toMatchObject({ status: 'completed', exitCode: 0 })
  })

  it.skipIf(process.platform === 'win32')(
    'kills the complete process tree when its owner is cancelled',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-owned-tree-'))
      const ready = join(root, 'grandchild-started')
      const marker = join(root, 'grandchild-finished')
      const runtime = new OwnedProcessRuntime(root)
      const childScript = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'done'),500)`
      const parentScript = [
        'const {spawn}=require("node:child_process")',
        `spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'}).unref()`,
        'setTimeout(()=>{},5000)',
      ].join(';')
      const running = runtime.run({
        executable: process.execPath,
        args: ['-e', parentScript],
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
        owner,
        containment: containment(root),
        timeoutMs: 5_000,
      })
      await waitFor(() => runtime.list({ activeOnly: true }).length === 1)
      await waitFor(() => existsSync(ready))

      await runtime.cancelOwner(owner, 'session closed')
      await expect(running).resolves.toMatchObject({ status: 'cancelled' })
      await delay(700)
      expect(existsSync(marker)).toBe(false)
      expect(runtime.list()[0]).toMatchObject({
        status: 'cancelled',
        terminalReason: 'session closed',
      })
    },
  )

  it('requires the current lease for explicit same-session reparenting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-reparent-'))
    const runtime = new OwnedProcessRuntime(root)
    const running = runtime.run({
      executable: process.execPath,
      args: ['-e', 'setTimeout(()=>{},5000)'],
      cwd: root,
      env: {},
      owner,
      containment: containment(root),
      timeoutMs: 5_000,
    })
    await waitFor(() => runtime.list({ activeOnly: true }).length === 1)
    const before = runtime.list({ activeOnly: true })[0]!
    const nextOwner = {
      kind: 'terminal' as const,
      id: 'terminal-b',
      sessionId: 'session-a',
    }

    expect(() => runtime.reparent(before.id, 'stale-lease', nextOwner)).toThrow(
      ProcessLeaseConflictError,
    )
    const after = runtime.reparent(before.id, before.lease.id, nextOwner)
    expect(after.owner).toEqual(nextOwner)
    expect(after.lease.id).not.toBe(before.lease.id)
    expect(after.lease.revision).toBe(before.lease.revision + 1)

    await runtime.cancelOwner(owner, 'old owner closed')
    expect(runtime.list({ activeOnly: true })).toHaveLength(1)
    await runtime.cancelOwner(nextOwner, 'terminal closed')
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('terminates a producer at the combined output quota and records the policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-output-quota-'))
    const runtime = new OwnedProcessRuntime(root)
    const result = await runtime.run({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write("x".repeat(100000));setTimeout(()=>{},5000)',
      ],
      cwd: root,
      env: {},
      owner,
      containment: containment(root),
      maxOutputBytes: 1_024,
    })

    expect(result.status).toBe('output_limit')
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(1_024)
    expect(runtime.list()[0]?.outputQuota).toMatchObject({
      strategy: 'terminate',
      scope: 'combined',
      exceeded: true,
      capturedBytes: 1_024,
    })
  })

  it('owns timeout termination instead of leaving cleanup to the caller', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-owned-timeout-'))
    const runtime = new OwnedProcessRuntime(root)

    await expect(
      runtime.run({
        executable: process.execPath,
        args: ['-e', 'setTimeout(()=>{},5000)'],
        cwd: root,
        env: {},
        owner,
        containment: containment(root),
        timeoutMs: 20,
      }),
    ).resolves.toMatchObject({ status: 'timeout' })
    expect(runtime.list({ activeOnly: true })).toEqual([])
    expect(runtime.list()[0]).toMatchObject({
      status: 'timeout',
      terminalReason: 'process timed out after 20ms',
    })
  })

  it('offers owned interactive stdio without persisting unrecoverable stream handles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-owned-stdio-'))
    const runtime = new OwnedProcessRuntime(root)
    const handle = await runtime.spawn({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdin.once("data",c=>process.stdout.write(String(c).toUpperCase()))',
      ],
      cwd: root,
      env: {},
      owner: { kind: 'mcp', id: 'server-a', sessionId: 'session-a' },
      containment: containment(root),
      maxOutputBytes: 4_096,
    })
    let stdout = ''
    handle.stdout.on('data', (chunk) => (stdout += String(chunk)))
    handle.stdin.write('ping')
    handle.stdin.end()

    await expect(handle.settled).resolves.toMatchObject({
      status: 'completed',
      exitCode: 0,
    })
    expect(stdout).toBe('PING')
    const serialized = readFileSync(runtime.receiptsPath, 'utf8')
    expect(serialized).not.toContain('ping')
    expect(serialized).not.toContain('_handle')
  })
})

describe('OwnedProcessRuntime recovery and capability', () => {
  it('reaps only an exact live orphan identity and never blindly reattaches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-orphan-'))
    const calls: number[] = []
    let alive = true
    const fixture = runningReceipt({ pid: 4242 })
    const runtime = new OwnedProcessRuntime(root, {
      initialReceipts: [fixture],
      bootMarker: () => fixture.bootMarker,
      processIdentity: () => fixture.processStartIdentity,
      pidAlive: () => alive,
      killTree: (pid) => {
        calls.push(pid)
        alive = false
      },
    })

    const reconciled = await runtime.reconcileOrphans()

    expect(calls).toEqual([4242])
    expect(reconciled).toEqual([fixture.id])
    expect(runtime.get(fixture.id)).toMatchObject({
      status: 'orphan_reaped',
      terminalReason: 'startup orphan reconcile',
    })
    expect(runtime.list({ activeOnly: true })).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'reaps a real live process left by a crashed runtime receipt',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-real-orphan-'))
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      const pid = child.pid!
      const bootMarker = systemBootMarker()
      const processStartIdentity = stableProcessStartIdentity(pid, bootMarker)
      expect(bootMarker).toBeTruthy()
      expect(processStartIdentity).toBeTruthy()
      const fixture = runningReceipt({
        id: 'process_real_orphan',
        pid,
        bootMarker,
        processStartIdentity,
      })
      const runtime = new OwnedProcessRuntime(root, {
        initialReceipts: [fixture],
      })

      try {
        await expect(runtime.reconcileOrphans()).resolves.toEqual([fixture.id])
        expect(runtime.get(fixture.id)).toMatchObject({
          status: 'orphan_reaped',
        })
        expect(pidIsAlive(pid)).toBe(false)
      } finally {
        if (pidIsAlive(pid)) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // Best-effort test cleanup.
          }
        }
      }
    },
  )

  it.each(['darwin', 'linux', 'win32'] as const)(
    'reports explicit sandbox, identity, process-tree and terminal capability on %s',
    (platform) => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-process-cap-'))
      const runtime = new OwnedProcessRuntime(root, { platform })

      expect(runtime.capabilityReport()).toMatchObject({
        platform,
        ownership: true,
        leases: true,
        reparent: true,
        orphanReconcile: true,
        processTree: platform === 'win32' ? 'taskkill' : 'process_group',
        terminal: { interactiveStdio: true, pty: false, resize: false },
        outputQuota: { defaultStrategy: 'terminate' },
        sandbox: { platform },
      })
    },
  )
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('condition not reached')
}

function runningReceipt(
  overrides: Partial<OwnedProcessReceipt> = {},
): OwnedProcessReceipt {
  return {
    schemaVersion: 1,
    id: 'process_fixture',
    owner,
    lease: {
      id: 'process_lease_fixture',
      revision: 1,
      acquiredAt: '2026-07-19T00:00:00.000Z',
    },
    commandDigest: 'a'.repeat(64),
    cwdCapability: {
      access: 'execute',
      cwdDigest: 'b'.repeat(64),
      workspaceRootDigest: 'c'.repeat(64),
      withinWorkspace: true,
    },
    containment: {
      decision: 'sandboxed',
      backend: 'linux-bwrap',
      capabilityStatus: 'available',
      filesystem: 'workspace-write',
      network: 'denied',
      processTree: true,
      policyHash: 'd'.repeat(64),
      reason: '',
    },
    outputQuota: {
      maxBytes: 1_024,
      strategy: 'terminate',
      scope: 'combined',
      observedBytes: 0,
      capturedBytes: 0,
      exceeded: false,
    },
    status: 'running',
    pid: 4242,
    bootMarker: 'e'.repeat(64),
    processStartIdentity: {
      kind: 'linux_proc_start_ticks',
      value: 'f'.repeat(64),
    },
    startedAt: '2026-07-19T00:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    signal: null,
    terminalReason: null,
    ...overrides,
  }
}
