import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
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
import type { ProcessContainmentController } from '../environment/sandbox'
import { processContainmentPolicy } from '../sandbox/presets'

const owner = {
  kind: 'session' as const,
  id: 'session-a',
  sessionId: 'session-a',
}

function sandboxExecution(
  root: string,
  executables: string[] = [process.execPath],
) {
  return {
    kind: 'sandbox' as const,
    policy: processContainmentPolicy({
      workspace: { root, access: 'write' },
      stateRoot: null,
      tempDir: root,
      network: 'deny',
      fallback: 'refuse',
      executables,
    }),
  }
}

describe('OwnedProcessRuntime receipts', () => {
  it('owns an authorized host process and persists only a bounded authorization summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-owned-host-'))
    let sandboxPrepareCalls = 0
    const sandbox: ProcessContainmentController = {
      capability: () => ({
        platform: 'darwin',
        backend: 'macos-seatbelt',
        status: 'available',
        filesystem: 'workspace-write',
        network: 'policy-controlled',
        processTree: true,
        reason: 'ready',
      }),
      contain: () => {
        sandboxPrepareCalls += 1
        throw new Error('host execution must bypass sandbox preparation')
      },
    }
    const runtime = new OwnedProcessRuntime(root, { sandbox })
    const authorizationId = 'permission_secret_request'

    const result = await runtime.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("host-runtime")'],
      cwd: root,
      env: {},
      owner,
      execution: {
        kind: 'host',
        authorization: {
          version: 1,
          toolName: 'run_command',
          operationFingerprint: 'f'.repeat(64),
          source: 'user_approved_once',
          permissionMode: 'smart_auto',
          rule: 'user.approved_once',
          authorizationId,
        },
      },
    })

    expect(result).toMatchObject({
      status: 'completed',
      stdout: 'host-runtime',
      containment: { decision: 'user-allowed-unsandboxed', backend: 'none' },
    })
    expect(sandboxPrepareCalls).toBe(0)
    expect(runtime.list()[0]).toMatchObject({
      executionBoundary: {
        kind: 'host',
        authorization: {
          source: 'user_approved_once',
          permissionMode: 'smart_auto',
          rule: 'user.approved_once',
          operationFingerprintDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          authorizationIdDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      containment: {
        decision: 'user-allowed-unsandboxed',
        reason: 'authorized host execution',
      },
    })
    expect(readFileSync(runtime.receiptsPath, 'utf8')).not.toContain(
      authorizationId,
    )
    expect(readFileSync(runtime.receiptsPath, 'utf8')).not.toContain(
      'f'.repeat(64),
    )
  })

  it('kills every running process at once when quitting overruns (FIX-07)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-terminate-all-'))
    const sandbox: ProcessContainmentController = {
      capability: () => ({
        platform: 'darwin',
        backend: 'macos-seatbelt',
        status: 'available',
        filesystem: 'workspace-write',
        network: 'policy-controlled',
        processTree: true,
        reason: 'ready',
      }),
      contain: () => {
        throw new Error('unused')
      },
    }
    const killed: number[] = []
    const runtime = new OwnedProcessRuntime(root, {
      sandbox,
      killTree: (pid) => {
        killed.push(pid)
        process.kill(pid, 'SIGKILL')
      },
    })
    const running = runtime.run({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root,
      env: {},
      owner,
      execution: {
        kind: 'host',
        authorization: {
          version: 1,
          toolName: 'run_command',
          operationFingerprint: 'f'.repeat(64),
          source: 'user_approved_once',
          permissionMode: 'smart_auto',
          rule: 'user.approved_once',
          authorizationId: 'quit',
        },
      },
    })
    for (let i = 0; i < 100 && runtime.list()[0]?.status !== 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    const pid = runtime.list()[0]?.pid
    expect(pid).toBeGreaterThan(0)
    runtime.terminateAll('app quit timeout')
    // Synchronous: the kill happened before terminateAll returned.
    expect(killed).toEqual([pid])
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('normalizes a legacy receipt without an execution boundary as sandboxed', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-owned-legacy-'))
    const runtime = new OwnedProcessRuntime(root, {
      initialReceipts: [runningReceipt()],
    })

    expect(runtime.list()[0]).toMatchObject({
      executionBoundary: { kind: 'sandbox', authorization: null },
    })
  })

  it('reads a pre-SEC-08 containment receipt in the new words', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-owned-legacy-'))
    const legacy = (containment: Record<string, unknown>) =>
      ({ ...runningReceipt(), containment }) as unknown as OwnedProcessReceipt
    const runtime = new OwnedProcessRuntime(root, {
      initialReceipts: [
        legacy({
          decision: 'sandboxed',
          backend: 'macos-seatbelt',
          policyHash: 'a',
        }),
        {
          ...legacy({
            decision: 'unsandboxed',
            backend: 'none',
            policyHash: 'b',
            reason: 'x',
          }),
          id: 'process_fixture_2',
        },
        {
          ...legacy({
            decision: 'denied',
            backend: 'linux-bwrap',
            policyHash: 'c',
          }),
          id: 'process_fixture_3',
        },
      ],
    })
    expect(runtime.list().map((receipt) => receipt.containment)).toEqual([
      {
        backend: 'seatbelt',
        decision: 'contained',
        policyHash: 'a',
        reason: '',
      },
      {
        backend: 'none',
        decision: 'user-allowed-unsandboxed',
        policyHash: 'b',
        reason: 'x',
      },
      { backend: 'none', decision: 'refused', policyHash: 'c', reason: '' },
    ])
  })

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
      execution: sandboxExecution(root),
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
      execution: sandboxExecution(root),
    })
    await delay(20)

    expect(result).toMatchObject({ status: 'completed', exitCode: 0 })
  })

  it.skipIf(process.platform === 'win32')(
    'kills the complete process tree when its owner is cancelled',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-owned-tree-'))
      const ready = join(root, 'grandchild-started')
      const runtime = new OwnedProcessRuntime(root)
      // The grandchild leaves the process group (detached) and writes its pid
      // once it runs; the cancel has to find it through the tree walk.
      const childScript = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>{},30000)`
      const parentScript = [
        'const {spawn}=require("node:child_process")',
        `spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'}).unref()`,
        'setTimeout(()=>{},30000)',
      ].join(';')
      const running = runtime.run({
        executable: process.execPath,
        args: ['-e', parentScript],
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
        owner,
        execution: sandboxExecution(root),
        timeoutMs: 30_000,
      })
      // Two node processes start one after the other: seconds on a loaded runner.
      await waitFor(
        () => existsSync(ready) && readFileSync(ready, 'utf8').length > 0,
      )
      const grandchild = Number(readFileSync(ready, 'utf8'))
      try {
        await runtime.cancelOwner(owner, 'session closed')
        await expect(running).resolves.toMatchObject({ status: 'cancelled' })
        // The kill is sent before cancelOwner returns; the grandchild is gone
        // as soon as the system has reaped it.
        await waitFor(() => !pidIsAlive(grandchild))
        expect(runtime.list()[0]).toMatchObject({
          status: 'cancelled',
          terminalReason: 'session closed',
        })
      } finally {
        if (pidIsAlive(grandchild)) process.kill(grandchild, 'SIGKILL')
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'stops a shell before its children, so it never runs its next command (FIX-17)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-owned-shell-'))
      const late = join(root, 'late')
      const runtime = new OwnedProcessRuntime(root)
      // A subshell waits on its own sleep. Killing the sleep before the
      // subshell let the subshell run `echo` while the tree walk went on.
      const running = runtime.run({
        executable: '/bin/sh',
        args: ['-c', '(sleep 20; echo late > "$LATE") & sleep 20'],
        cwd: root,
        env: { PATH: '/usr/bin:/bin', LATE: late },
        owner,
        execution: sandboxExecution(root, ['/bin/sh']),
        timeoutMs: 30_000,
      })
      await waitFor(() => (runtime.list({ activeOnly: true })[0]?.pid ?? 0) > 0)
      const pid = runtime.list({ activeOnly: true })[0]!.pid!
      // The subshell's sleep runs: the tree is two levels deep.
      await waitFor(() => childPids(pid).some((c) => childPids(c).length > 0))
      await runtime.cancelOwner(owner, 'session closed')
      // The output pipe closes only once every process holding it is gone,
      // the subshell too: whatever it was going to write is written by now.
      await expect(running).resolves.toMatchObject({ status: 'cancelled' })
      expect(existsSync(late)).toBe(false)
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
      execution: sandboxExecution(root),
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
      execution: sandboxExecution(root),
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
        execution: sandboxExecution(root),
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
      execution: sandboxExecution(root),
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

/** Poll until `predicate` holds; bounded by time, not by a count of polls. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`condition not reached in ${timeoutMs} ms`)
    await delay(10)
  }
}

/** The direct children of `pid` (none when it has none or is gone). */
function childPids(pid: number): number[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
    })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
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
      decision: 'contained',
      backend: 'bwrap',
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
