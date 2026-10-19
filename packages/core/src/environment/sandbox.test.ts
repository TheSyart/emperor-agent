import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mcpServerContainment } from '../mcp/containment'
import { ContainmentBackend, type ContainmentPolicy } from '../sandbox/policy'
import { processContainmentPolicy } from '../sandbox/presets'
import { OsSandboxController } from './sandbox'
import { NodeOwnedProcessRunner } from './process-runner'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // no-op
    }
  }
})

function policy(
  workspaceRoot = '/workspace',
  extra: { read?: string[]; write?: string[] } = {},
): ContainmentPolicy {
  return processContainmentPolicy({
    workspace: { root: workspaceRoot, access: 'write' },
    stateRoot: join(workspaceRoot, '.emperor'),
    tempDir: join(workspaceRoot, '.tmp'),
    read: ['/runtime/bin', ...(extra.read ?? [])],
    write: extra.write ?? [],
    network: 'deny',
    fallback: 'refuse',
    env: { PATH: '/usr/bin:/bin' },
    home: '/Users/example',
  })
}

const seatbelt = (ok = true) =>
  new OsSandboxController({
    backend: new ContainmentBackend({
      platform: 'darwin',
      probe: () => ({
        ok,
        detail: ok ? 'seatbelt probe passed' : 'mock: broken',
      }),
    }),
  })

describe('OsSandboxController (adapter over the one backend, SEC-08)', () => {
  it('prepares a macOS Seatbelt profile without exposing arbitrary outside paths', async () => {
    const controller = seatbelt()
    expect(controller.capability()).toMatchObject({
      platform: 'darwin',
      backend: 'macos-seatbelt',
      status: 'available',
      filesystem: 'workspace-write',
      network: 'policy-controlled',
      processTree: true,
    })
    const prepared = await controller.contain(
      '/bin/sh',
      ['-c', 'pwd'],
      policy(),
    )
    expect(prepared.receipt).toMatchObject({
      decision: 'contained',
      backend: 'seatbelt',
    })
    expect(prepared.executable).toBe('/usr/bin/sandbox-exec')
    expect(prepared.args.slice(0, 2)).toEqual(['-p', expect.any(String)])
    const profile = prepared.args[1]!
    expect(profile).toContain('(deny file-read*)')
    expect(profile).toContain('(subpath "/workspace")')
    expect(profile).toContain(
      '(deny file-read* (subpath "/workspace/.emperor"))',
    )
    expect(profile).toContain('(deny network*)')
    expect(profile).not.toContain('/Users/example/private')
    expect(prepared.args.slice(-3)).toEqual(['/bin/sh', '-c', 'pwd'])
    expect(prepared.env.TMPDIR).toBe('/workspace/.tmp')
  })

  it('allows only metadata reads for ancestors of a read-only runtime root', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'emperor-sandbox-profile-'))
    const outside = mkdtempSync(join(tmpdir(), 'emperor-runtime-root-'))
    cleanup.push(workspace, outside)
    const runtimeRoot = join(outside, 'opt', 'homebrew', 'bin')
    mkdirSync(runtimeRoot, { recursive: true })
    const prepared = await seatbelt().contain(
      '/bin/sh',
      ['-c', 'pwd'],
      policy(workspace, { read: [runtimeRoot] }),
    )
    const profile = prepared.args[1]!
    const canonicalOutside = realpathSync(outside)

    expect(profile).toContain('(allow file-read-metadata')
    expect(profile).toContain(`(literal "${canonicalOutside}")`)
    expect(profile).toContain(
      `(literal "${join(canonicalOutside, 'opt', 'homebrew')}")`,
    )
    expect(profile).not.toContain(
      `(subpath "${join(canonicalOutside, 'opt')}")`,
    )
  })

  it("grants a plugin's named folders inside the state root and drops any other grant", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-sandbox-grants-'))
    cleanup.push(stateRoot)
    const read = join(stateRoot, 'plugins', 'cache', 'kit')
    const write = join(stateRoot, 'plugins', 'data', 'kit')
    const base = {
      name: 'kit-docs',
      source: 'plugin' as const,
      stateRoot,
      workspaceRoot: join(stateRoot, 'workspace'),
      command: '/bin/sh',
      args: [],
      env: { PATH: '/usr/bin:/bin' },
      home: '/Users/example',
    }
    const granted = mcpServerContainment({
      ...base,
      grants: {
        read: [read, '/elsewhere/package', stateRoot],
        write: [write, '/workspace'],
      },
    }).policy
    const real = realpathSync(stateRoot)
    expect(granted.read.allow).toContain(join(real, 'plugins', 'cache', 'kit'))
    expect(granted.write.allow).toContain(join(real, 'plugins', 'data', 'kit'))
    // Only strict subfolders of the state root are granted.
    expect(JSON.stringify(granted)).not.toContain('/elsewhere/package')
    expect(granted.read.allow).not.toContain(real)
    expect(granted.write.allow).not.toContain('/workspace')
    expect(granted.fallback).toBe('refuse')
  })

  it('prepares Linux bwrap without a read-only bind of the whole host root', async () => {
    const controller = new OsSandboxController({
      backend: new ContainmentBackend({
        platform: 'linux',
        probe: () => ({ ok: true, detail: 'user namespaces enabled' }),
      }),
    })
    const prepared = await controller.contain(
      '/bin/sh',
      ['-c', 'pwd'],
      policy(),
    )

    expect(prepared.receipt).toMatchObject({
      decision: 'contained',
      backend: 'bwrap',
    })
    expect(prepared.executable).toBe('bwrap')
    expect(prepared.args).toContain('--unshare-net')
    expect(prepared.args).toContain('--die-with-parent')
    expect(prepared.args.join(' ')).not.toContain('--ro-bind / /')
    expect(prepared.args.slice(-3)).toEqual(['/bin/sh', '-c', 'pwd'])
  })

  it('reports unavailable and unsupported backends and refuses — never a silent unsandboxed start', async () => {
    const missing = seatbelt(false)
    expect(missing.capability()).toMatchObject({
      backend: 'macos-seatbelt',
      status: 'unavailable',
      reason: 'mock: broken',
    })
    for (const fallback of ['refuse', 'ask-user'] as const)
      expect(
        (
          await missing.contain('/bin/sh', ['-c', 'pwd'], {
            ...policy(),
            fallback,
          })
        ).receipt,
      ).toMatchObject({ decision: 'refused', backend: 'none' })

    const windows = new OsSandboxController({ platform: 'win32' })
    expect(windows.capability()).toMatchObject({
      backend: 'windows-unsupported',
      status: 'unsupported',
    })
  })
})

describe('NodeOwnedProcessRunner containment', () => {
  const realController = new OsSandboxController()
  const runnable = realController.capability().status === 'available'

  it.runIf(runnable)(
    'lets a process read its granted package and write its granted data folder, and nothing else in the state root',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'emperor-sandbox-grants-'))
      cleanup.push(workspace)
      const stateRoot = join(workspace, '.emperor')
      const packageRoot = join(stateRoot, 'plugins', 'cache', 'kit')
      const dataRoot = join(stateRoot, 'plugins', 'data', 'kit')
      const tempRoot = join(workspace, '.sandbox-tmp')
      for (const dir of [packageRoot, dataRoot, tempRoot])
        mkdirSync(dir, { recursive: true })
      writeFileSync(join(packageRoot, 'server.txt'), 'package', 'utf8')
      writeFileSync(join(stateRoot, 'secret.txt'), 'state-secret', 'utf8')
      const runner = new NodeOwnedProcessRunner({ sandbox: realController })
      const run = (command: string) =>
        runner.run({
          cwd: packageRoot,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace },
          timeoutMs: 5_000,
          execution: {
            kind: 'sandbox' as const,
            policy: processContainmentPolicy({
              workspace: { root: workspace, access: 'write' },
              stateRoot,
              tempDir: tempRoot,
              read: [packageRoot],
              write: [dataRoot],
              network: 'deny',
              fallback: 'refuse',
            }),
          },
          executable: '/bin/sh',
          args: ['-c', command],
        })

      const readPackage = await run('cat server.txt')
      expect(readPackage).toMatchObject({ exitCode: 0 })
      expect(readPackage.stdout).toBe('package')
      expect(
        (await run(`printf data > "${join(dataRoot, 'out.txt')}"`)).exitCode,
      ).toBe(0)
      expect(readFileSync(join(dataRoot, 'out.txt'), 'utf8')).toBe('data')
      for (const command of [
        `printf x > "${join(packageRoot, 'tampered.txt')}"`,
        `cat "${join(stateRoot, 'secret.txt')}"`,
      ]) {
        const result = await run(command)
        expect(result.exitCode, command).not.toBe(0)
      }
      expect(existsSync(join(packageRoot, 'tampered.txt'))).toBe(false)
    },
  )

  it.runIf(runnable)(
    'blocks outside read/write, state-root access, symlink escape, child escape, and network while allowing workspace writes',
    async () => {
      const workspace = mkdtempSync(
        join(tmpdir(), 'emperor-sandbox-workspace-'),
      )
      const outside = mkdtempSync(join(tmpdir(), 'emperor-sandbox-outside-'))
      cleanup.push(workspace, outside)
      const stateRoot = join(workspace, '.emperor')
      const tempRoot = join(workspace, '.sandbox-tmp')
      const outsideSecret = join(outside, 'secret.txt')
      const outsideWrite = join(outside, 'escaped.txt')
      const workspaceWrite = join(workspace, 'inside.txt')
      const stateSecret = join(stateRoot, 'secret.txt')
      const link = join(workspace, 'outside-link')
      mkdirSync(stateRoot, { recursive: true })
      mkdirSync(tempRoot, { recursive: true })
      writeFileSync(outsideSecret, 'outside-secret', 'utf8')
      writeFileSync(stateSecret, 'state-secret', {
        encoding: 'utf8',
        flag: 'w',
      })
      symlinkSync(outside, link)
      const runner = new NodeOwnedProcessRunner({ sandbox: realController })
      const common = {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: workspace,
        },
        timeoutMs: 5_000,
        execution: {
          kind: 'sandbox' as const,
          policy: processContainmentPolicy({
            workspace: { root: workspace, access: 'write' },
            stateRoot,
            tempDir: tempRoot,
            read: [dirname(process.execPath)],
            network: 'deny',
            fallback: 'refuse',
            executables: [process.execPath],
          }),
        },
      }

      const inside = await runner.run({
        ...common,
        executable: '/bin/sh',
        args: ['-c', `printf inside > "${workspaceWrite}"`],
      })
      expect(inside).toMatchObject({
        status: 'completed',
        exitCode: 0,
        containment: { decision: 'contained' },
      })
      expect(readFileSync(workspaceWrite, 'utf8')).toBe('inside')

      for (const command of [
        `cat "${outsideSecret}"`,
        `printf escaped > "${outsideWrite}"`,
        `cat "${stateSecret}"`,
        `printf escaped > "${join(link, 'symlink-escaped.txt')}"`,
        `/bin/sh -c 'printf escaped > "${join(outside, 'child-escaped.txt')}"'`,
      ]) {
        const result = await runner.run({
          ...common,
          executable: '/bin/sh',
          args: ['-c', command],
        })
        expect(result.exitCode, command).not.toBe(0)
        expect(result.containment.decision, command).toBe('contained')
      }
      expect(existsSync(outsideWrite)).toBe(false)
      expect(existsSync(join(outside, 'symlink-escaped.txt'))).toBe(false)
      expect(existsSync(join(outside, 'child-escaped.txt'))).toBe(false)

      const server = createServer()
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('no port')
        const network = await runner.run({
          ...common,
          executable: process.execPath,
          args: [
            '-e',
            `require('node:net').connect(${address.port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(7))`,
          ],
          timeoutMs: 2_000,
        })
        expect(network).toMatchObject({
          status: 'completed',
          exitCode: 7,
          containment: { decision: 'contained' },
        })
      } finally {
        server.close()
      }
    },
    20_000,
  )
})
