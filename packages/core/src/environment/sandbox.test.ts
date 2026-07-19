import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OsSandboxController, type ProcessContainmentPolicy } from './sandbox'
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

function policy(workspaceRoot = '/workspace'): ProcessContainmentPolicy {
  return {
    mode: 'required',
    workspaceRoot,
    stateRoot: join(workspaceRoot, '.emperor'),
    tempRoot: join(workspaceRoot, '.tmp'),
    readOnlyRoots: ['/runtime/bin'],
    network: 'deny',
  }
}

describe('OsSandboxController capability and preparation', () => {
  it('prepares a macOS Seatbelt profile without exposing arbitrary outside paths', () => {
    const controller = new OsSandboxController({
      platform: 'darwin',
      pathExists: (path) => path === '/usr/bin/sandbox-exec',
      probeProcess: () => ({ ok: true, detail: 'seatbelt probe passed' }),
    })

    expect(controller.capability()).toMatchObject({
      platform: 'darwin',
      backend: 'macos-seatbelt',
      status: 'available',
      filesystem: 'workspace-write',
      network: 'policy-controlled',
      processTree: true,
    })
    const prepared = controller.prepare('/bin/sh', ['-c', 'pwd'], policy())
    expect(prepared.receipt).toMatchObject({
      decision: 'sandboxed',
      backend: 'macos-seatbelt',
      network: 'denied',
      filesystem: 'workspace-write',
    })
    expect(prepared.executable).toBe('/usr/bin/sandbox-exec')
    expect(prepared.args.slice(0, 2)).toEqual(['-p', expect.any(String)])
    const profile = prepared.args[1]!
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('/workspace')
    expect(profile).toContain('/workspace/.emperor')
    expect(profile).toContain('(deny network*)')
    expect(profile).not.toContain('/Users/example/private')
    expect(prepared.args.slice(-3)).toEqual(['/bin/sh', '-c', 'pwd'])
  })

  it('prepares Linux bwrap without a read-only bind of the whole host root', () => {
    const controller = new OsSandboxController({
      platform: 'linux',
      pathExists: (path) => path === '/usr/bin/bwrap',
      probeProcess: () => ({ ok: true, detail: 'user namespaces enabled' }),
    })
    const prepared = controller.prepare('/bin/sh', ['-c', 'pwd'], policy())

    expect(prepared.receipt).toMatchObject({
      decision: 'sandboxed',
      backend: 'linux-bwrap',
      network: 'denied',
    })
    expect(prepared.executable).toBe('/usr/bin/bwrap')
    expect(prepared.args).toContain('--unshare-net')
    expect(prepared.args).toContain('--die-with-parent')
    expect(prepared.args.join(' ')).not.toContain('--ro-bind / /')
    expect(prepared.args.slice(-3)).toEqual(['/bin/sh', '-c', 'pwd'])
  })

  it('reports unavailable and unsupported backends as typed decisions', () => {
    const missing = new OsSandboxController({
      platform: 'linux',
      pathExists: () => false,
    })
    expect(missing.capability()).toMatchObject({
      backend: 'linux-bwrap',
      status: 'unavailable',
    })
    expect(
      missing.prepare('/bin/sh', ['-c', 'pwd'], policy()).receipt,
    ).toMatchObject({ decision: 'denied', backend: 'linux-bwrap' })
    expect(
      missing.prepare('/bin/sh', ['-c', 'pwd'], {
        ...policy(),
        mode: 'preferred',
      }).receipt,
    ).toMatchObject({ decision: 'unsandboxed', backend: 'none' })

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
        containment: {
          mode: 'required' as const,
          workspaceRoot: workspace,
          stateRoot,
          tempRoot,
          readOnlyRoots: [dirname(process.execPath)],
          network: 'deny' as const,
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
        containment: { decision: 'sandboxed' },
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
        expect(result.containment.decision, command).toBe('sandboxed')
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
          containment: { decision: 'sandboxed', network: 'denied' },
        })
      } finally {
        server.close()
      }
    },
    20_000,
  )
})
