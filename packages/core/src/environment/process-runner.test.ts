import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  managedEnvironmentOperationFingerprint,
  NodeEnvironmentProcessRunner,
  NodeOwnedProcessRunner,
} from './process-runner'
import type { ProcessContainmentController } from './sandbox'

describe('NodeEnvironmentProcessRunner', () => {
  it('spawns with shell disabled and captures bounded output', async () => {
    const observed: Array<Record<string, unknown>> = []
    const runner = new NodeEnvironmentProcessRunner({
      onSpawn: (options) => observed.push(options),
    })
    const result = await runner.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("version 1.2.3")'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })

    expect(result).toMatchObject({
      status: 'completed',
      exitCode: 0,
      stdout: 'version 1.2.3',
    })
    expect(observed).toEqual([
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        timeoutMs: 5_000,
      }),
    ])
  })

  it('contains stdin EPIPE when a short-lived child exits without reading input', async () => {
    const runner = new NodeEnvironmentProcessRunner()

    const result = await runner.run({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {},
      stdin: Buffer.alloc(2 * 1_024 * 1_024, 'x'),
    })
    await delay(20)

    expect(result).toMatchObject({ status: 'completed', exitCode: 0 })
  })

  it('preserves the bounded thirty-minute installer timeout', async () => {
    const observed: Array<Record<string, unknown>> = []
    const runner = new NodeEnvironmentProcessRunner({
      onSpawn: (options) => observed.push(options),
    })

    await runner.run({
      executable: process.execPath,
      args: ['-e', ''],
      env: {},
      timeoutMs: 30 * 60 * 1_000,
    })

    expect(observed[0]).toMatchObject({ timeoutMs: 30 * 60 * 1_000 })
  })

  it('enforces timeout and byte-level combined output limits', async () => {
    const runner = new NodeEnvironmentProcessRunner()
    const timedOut = await runner.run({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      env: {},
      timeoutMs: 50,
    })
    expect(timedOut.status).toBe('timeout')
    expect(timedOut.durationMs).toBeLessThan(2_000)

    const bounded = await runner.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(200000))'],
      env: {},
      maxOutputBytes: 1_024,
    })
    expect(bounded.status).toBe('output_limit')
    expect(
      Buffer.byteLength(bounded.stdout) + Buffer.byteLength(bounded.stderr),
    ).toBeLessThanOrEqual(1_024)
  })

  it('distinguishes cancellation and spawn failures', async () => {
    const runner = new NodeEnvironmentProcessRunner()
    const controller = new AbortController()
    const running = runner.run({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      env: {},
      signal: controller.signal,
    })
    controller.abort()
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })

    await expect(
      runner.run({
        executable: '/definitely/missing/emperor-tool',
        args: ['--version'],
        env: {},
      }),
    ).resolves.toMatchObject({ status: 'spawn_error', exitCode: null })
  })

  it('terminates the spawned process tree on cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emperor-process-tree-'))
    const marker = join(dir, 'grandchild-ran')
    const spawned = join(dir, 'grandchild-spawned')
    const runner = new NodeEnvironmentProcessRunner()
    const controller = new AbortController()
    // The grandchild writes its marker 1.5 s after it starts. Cancel only
    // once it exists: cancelling while the child was still spawning it
    // raced on a loaded CI runner.
    const childScript = [
      'const {spawn}=require("node:child_process")',
      'const fs=require("node:fs")',
      `const grandchild=spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'),1500)`)}])`,
      `grandchild.on("spawn",()=>fs.writeFileSync(${JSON.stringify(spawned)},"1"))`,
      'setTimeout(()=>{},10000)',
    ].join(';')
    const running = runner.run({
      executable: process.execPath,
      args: ['-e', childScript],
      env: { PATH: process.env.PATH ?? '' },
      signal: controller.signal,
    })
    await vi.waitFor(
      () => {
        if (!existsSync(spawned)) throw new Error('grandchild not spawned yet')
      },
      { timeout: 5_000 },
    )
    controller.abort()

    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    await delay(2_000)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('NodeOwnedProcessRunner', () => {
  it('runs a managed installer only when authorization matches executable argv and cwd', async () => {
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
      prepare: () => {
        sandboxPrepareCalls += 1
        throw new Error(
          'managed installation must not prepare workspace sandbox',
        )
      },
    }
    const runner = new NodeOwnedProcessRunner({ sandbox })
    const cwd = process.cwd()
    const args = ['-e', 'process.stdout.write("managed-ok")']
    const fingerprint = managedEnvironmentOperationFingerprint({
      executable: process.execPath,
      args,
      cwd,
    })

    const result = await runner.run({
      executable: process.execPath,
      args,
      cwd,
      env: {},
      execution: {
        kind: 'host',
        authorization: {
          version: 1,
          toolName: 'manage_environment',
          operationFingerprint: fingerprint,
          source: 'managed_environment_install',
          planId: 'env_plan_01',
          recipeDigest: 'b'.repeat(64),
          toolId: 'agent-reach',
          toolVersion: '1.2.3',
          emperorHomeDigest: 'c'.repeat(64),
          sessionId: 'session-01',
          authorizationId: 'env_plan_01',
        },
      },
      owner: {
        kind: 'environment',
        id: 'env_plan_01',
        sessionId: 'session-01',
      },
    })

    expect(result).toMatchObject({
      status: 'completed',
      exitCode: 0,
      stdout: 'managed-ok',
      containment: {
        decision: 'unsandboxed',
        backend: 'none',
        reason: 'authorized managed environment install',
      },
    })
    expect(sandboxPrepareCalls).toBe(0)

    const denied = await runner.run({
      executable: process.execPath,
      args: [...args, 'changed'],
      cwd,
      env: {},
      execution: {
        kind: 'host',
        authorization: {
          version: 1,
          toolName: 'manage_environment',
          operationFingerprint: fingerprint,
          source: 'managed_environment_install',
          planId: 'env_plan_01',
          recipeDigest: 'b'.repeat(64),
          toolId: 'agent-reach',
          toolVersion: '1.2.3',
          emperorHomeDigest: 'c'.repeat(64),
          sessionId: 'session-01',
          authorizationId: 'env_plan_01',
        },
      },
    })
    expect(denied).toMatchObject({
      status: 'containment_unavailable',
      containment: { decision: 'denied' },
    })
  })

  it('runs an authorized host process without preparing an OS sandbox', async () => {
    let sandboxPrepareCalls = 0
    const observed: Array<Record<string, unknown>> = []
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
      prepare: () => {
        sandboxPrepareCalls += 1
        throw new Error('host execution must not prepare the sandbox')
      },
    }
    const runner = new NodeOwnedProcessRunner({
      sandbox,
      onSpawn: (options) => observed.push(options),
    })

    const result = await runner.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("host-ok")'],
      env: {},
      execution: {
        kind: 'host',
        authorization: {
          version: 1,
          toolName: 'run_command',
          operationFingerprint: 'a'.repeat(64),
          source: 'full_access',
          permissionMode: 'full_access',
          rule: 'mode.full_access',
          authorizationId: null,
        },
      },
    })

    expect(result).toMatchObject({
      status: 'completed',
      exitCode: 0,
      stdout: 'host-ok',
      containment: {
        decision: 'unsandboxed',
        backend: 'none',
        capabilityStatus: 'not_required',
        filesystem: 'unrestricted',
        network: 'unrestricted',
      },
    })
    expect(sandboxPrepareCalls).toBe(0)
    expect(observed).toHaveLength(1)
  })

  it('rejects a malformed host authorization before spawn', async () => {
    let spawned = false
    const runner = new NodeOwnedProcessRunner({
      onSpawn: () => {
        spawned = true
      },
    })

    const result = await runner.run({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {},
      execution: {
        kind: 'host',
        authorization: {
          version: 1,
          toolName: 'read_file',
          operationFingerprint: 'not-a-fingerprint',
          source: 'full_access',
          permissionMode: 'full_access',
          rule: '',
          authorizationId: null,
        },
      },
    } as never)

    expect(result).toMatchObject({
      status: 'containment_unavailable',
      containment: { decision: 'denied', backend: 'none' },
    })
    expect(spawned).toBe(false)
  })

  it('fails closed before spawn when required containment is unavailable', async () => {
    let spawned = false
    const sandbox: ProcessContainmentController = {
      capability: () => ({
        platform: 'linux',
        backend: 'linux-bwrap',
        status: 'unavailable',
        filesystem: 'workspace-write',
        network: 'policy-controlled',
        processTree: true,
        reason: 'bwrap missing',
      }),
      prepare: (_executable, _args, policy) => ({
        executable: null,
        args: [],
        receipt: {
          decision: policy.mode === 'required' ? 'denied' : 'unsandboxed',
          backend:
            policy.mode === 'required' ? 'linux-bwrap' : ('none' as const),
          capabilityStatus: 'unavailable',
          filesystem:
            policy.mode === 'required' ? 'workspace-write' : 'unrestricted',
          network: policy.mode === 'required' ? 'denied' : 'unrestricted',
          processTree: policy.mode === 'required',
          policyHash: 'a'.repeat(64),
          reason: 'bwrap missing',
        },
      }),
    }
    const runner = new NodeOwnedProcessRunner({
      sandbox,
      onSpawn: () => {
        spawned = true
      },
    })

    const result = await runner.run({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {},
      execution: {
        kind: 'sandbox',
        policy: {
          mode: 'required',
          workspaceRoot: process.cwd(),
          stateRoot: null,
          tempRoot: process.cwd(),
          readOnlyRoots: [],
          network: 'deny',
        },
      },
    })

    expect(result).toMatchObject({
      status: 'containment_unavailable',
      exitCode: null,
      containment: {
        decision: 'denied',
        backend: 'linux-bwrap',
        capabilityStatus: 'unavailable',
      },
    })
    expect(spawned).toBe(false)
  })

  it('does not spawn when the containment receipt cannot be committed', async () => {
    let spawned = false
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
      prepare: (executable, args) => ({
        executable,
        args,
        receipt: {
          decision: 'sandboxed',
          backend: 'macos-seatbelt',
          capabilityStatus: 'available',
          filesystem: 'workspace-write',
          network: 'denied',
          processTree: true,
          policyHash: 'c'.repeat(64),
          reason: '',
        },
      }),
    }
    const runner = new NodeOwnedProcessRunner({
      sandbox,
      onSpawn: () => {
        spawned = true
      },
    })

    await expect(
      runner.run({
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: {},
        execution: {
          kind: 'sandbox',
          policy: {
            mode: 'required',
            workspaceRoot: process.cwd(),
            stateRoot: null,
            tempRoot: process.cwd(),
            readOnlyRoots: [],
            network: 'deny',
          },
        },
        onContainment: () => {
          throw new Error('receipt store unavailable')
        },
      }),
    ).rejects.toThrow(/receipt store unavailable/)
    expect(spawned).toBe(false)
  })
})
