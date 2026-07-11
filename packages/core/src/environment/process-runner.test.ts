import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { NodeEnvironmentProcessRunner } from './process-runner'

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
    const marker = join(
      mkdtempSync(join(tmpdir(), 'emperor-process-tree-')),
      'grandchild-ran',
    )
    const runner = new NodeEnvironmentProcessRunner()
    const controller = new AbortController()
    const childScript = [
      'const {spawn}=require("node:child_process")',
      `spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'),400)`)}])`,
      'setTimeout(()=>{},5000)',
    ].join(';')
    const running = runner.run({
      executable: process.execPath,
      args: ['-e', childScript],
      env: { PATH: process.env.PATH ?? '' },
      signal: controller.signal,
    })
    await delay(100)
    controller.abort()

    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    await delay(600)
    expect(existsSync(marker)).toBe(false)
  })
})
