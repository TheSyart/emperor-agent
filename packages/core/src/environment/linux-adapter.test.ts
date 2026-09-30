import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  loadBundledToolCatalog,
  type LoadedToolCatalog,
  type ToolCatalogStrategy,
} from './catalog'
import type { AssetDownloader } from './download'
import type { EnvironmentStepExecutionContext } from './jobs'
import {
  LinuxEnvironmentAdapter,
  detectSupportedUbuntu,
  linuxAppImageDiagnostics,
} from './linux-adapter'
import type { EnvironmentToolId } from './models'
import type {
  EnvironmentProcessRequest,
  EnvironmentProcessResult,
  EnvironmentProcessRunner,
} from './process-runner'

class FakeRunner implements EnvironmentProcessRunner {
  readonly calls: EnvironmentProcessRequest[] = []
  result: EnvironmentProcessResult = {
    status: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    error: null,
  }

  async run(
    request: EnvironmentProcessRequest,
  ): Promise<EnvironmentProcessResult> {
    this.calls.push(request)
    return this.result
  }
}

describe('LinuxEnvironmentAdapter', () => {
  it('accepts only Ubuntu 22.04 and 24.04 on x64', () => {
    expect(detectSupportedUbuntu('ID=ubuntu\nVERSION_ID="22.04"\n')).toEqual({
      id: 'ubuntu',
      versionId: '22.04',
    })
    expect(detectSupportedUbuntu('ID=ubuntu\nVERSION_ID=24.04\n')).toEqual({
      id: 'ubuntu',
      versionId: '24.04',
    })
    expect(() => detectSupportedUbuntu('ID=debian\nVERSION_ID=12\n')).toThrow()
    expect(() =>
      detectSupportedUbuntu('ID=ubuntu\nVERSION_ID=20.04\n'),
    ).toThrow()
  })

  it('runs exact catalog apt commands through fixed pkexec with a minimal env', async () => {
    const runner = new FakeRunner()
    const linux = fixtureAdapter({ runner })

    await expect(linux.execute(context('git', 'apt'))).resolves.toEqual({
      status: 'completed',
    })
    expect(runner.calls[0]).toMatchObject({
      executable: '/usr/bin/pkexec',
      args: ['apt-get', 'install', '-y', 'git'],
      timeoutMs: 30 * 60 * 1_000,
    })
    expect(runner.calls[0]!.env).not.toHaveProperty('API_TOKEN')
  })

  it('does not fall back to sudo or shell when pkexec is unavailable', async () => {
    const runner = new FakeRunner()
    const linux = fixtureAdapter({ runner, exists: () => false })
    const execution = context('ripgrep', 'apt')

    await expect(linux.execute(execution)).resolves.toEqual({
      status: 'awaiting_user',
    })
    expect(runner.calls).toEqual([])
    expect(execution.logs[0]).toMatchObject({ kind: 'pkexec_required' })
  })

  it('requires the apt step to carry an elevation plan proof', async () => {
    const runner = new FakeRunner()
    const execution = context('git', 'apt', { elevation: false })

    await expect(
      fixtureAdapter({ runner }).execute(execution),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'confirmation_required' },
    })
    expect(runner.calls).toEqual([])
  })

  it('maps pkexec refusal and process cancellation distinctly', async () => {
    const declinedRunner = new FakeRunner()
    declinedRunner.result = { ...declinedRunner.result, exitCode: 126 }
    await expect(
      fixtureAdapter({ runner: declinedRunner }).execute(context('git', 'apt')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'elevation_declined' },
    })

    const cancelledRunner = new FakeRunner()
    cancelledRunner.result = {
      ...cancelledRunner.result,
      status: 'cancelled',
      exitCode: null,
    }
    await expect(
      fixtureAdapter({ runner: cancelledRunner }).execute(
        context('git', 'apt'),
      ),
    ).resolves.toEqual({ status: 'cancelled' })
  })

  it('rejects unsupported distro and architecture before any process starts', async () => {
    const runner = new FakeRunner()
    await expect(
      fixtureAdapter({
        runner,
        osRelease: 'ID=fedora\nVERSION_ID=42\n',
      }).execute(context('git', 'apt')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'unsupported_platform' },
    })
    await expect(
      fixtureAdapter({ runner, arch: 'arm64' }).execute(context('git', 'apt')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'unsupported_arch' },
    })
    expect(runner.calls).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'runs existing version managers using exact catalog commands',
    async () => {
      const runner = new FakeRunner()
      const linux = fixtureAdapter({
        runner,
        exists: (path) =>
          path === '/usr/bin/pkexec' || path.endsWith('/.volta/bin/volta'),
      })

      await expect(linux.execute(context('node', 'volta'))).resolves.toEqual({
        status: 'completed',
      })
      expect(runner.calls[0]).toMatchObject({
        executable: expect.stringMatching(/\/\.volta\/bin\/volta$/),
        args: ['install', 'node@24.18.0'],
      })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'installs a digest-verified archive atomically and activates fixed links',
    async () => {
      const archive = tarGz([
        { name: 'uv-x86_64/uv', data: Buffer.from('uv'), mode: 0o755 },
        { name: 'uv-x86_64/uvx', data: Buffer.from('uvx'), mode: 0o755 },
      ])
      const fixture = assetCatalog('uv', {
        id: 'official-archive',
        kind: 'direct_archive',
        url: 'https://github.com/astral-sh/uv/releases/download/fixture/uv.tar.gz',
        sha256: sha256(archive),
        executable: 'uv',
        args: ['--version'],
      })
      const linux = fixtureAdapter({
        catalog: fixture.catalog,
        downloader: downloader(archive),
        root: fixture.root,
      })

      await expect(
        linux.execute(context('uv', 'official-archive')),
      ).resolves.toEqual({ status: 'completed' })
      const current = join(fixture.root, 'tools', 'uv', 'current')
      expect(readFileSync(join(current, 'uv-x86_64', 'uv'), 'utf8')).toBe('uv')
      const active = join(fixture.root, 'home', '.local', 'bin', 'uv')
      expect(lstatSync(active).isSymbolicLink()).toBe(true)
      expect(readlinkSync(active)).toContain(join('tools', 'uv', 'current'))
    },
  )

  it('blocks digest mismatch before extraction', async () => {
    const archive = tarGz([
      { name: 'uv', data: Buffer.from('uv'), mode: 0o755 },
    ])
    const fixture = assetCatalog('uv', {
      id: 'official-archive',
      kind: 'direct_archive',
      url: 'https://github.com/astral-sh/uv/releases/download/fixture/uv.tar.gz',
      sha256: sha256(Buffer.from('expected')),
      executable: 'uv',
      args: ['--version'],
    })

    await expect(
      fixtureAdapter({
        catalog: fixture.catalog,
        downloader: downloader(archive),
        root: fixture.root,
      }).execute(context('uv', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'integrity_failed' },
    })
    expect(existsSync(join(fixture.root, 'tools', 'uv'))).toBe(false)
  })

  it('rejects a symlinked managed root before touching external data', async () => {
    const archive = tarGz([
      { name: 'uv', data: Buffer.from('uv'), mode: 0o755 },
      { name: 'uvx', data: Buffer.from('uvx'), mode: 0o755 },
    ])
    const fixture = assetCatalog('uv', {
      id: 'official-archive',
      kind: 'direct_archive',
      url: 'https://github.com/astral-sh/uv/releases/download/fixture/uv.tar.gz',
      sha256: sha256(archive),
      executable: 'uv',
      args: ['--version'],
    })
    const outside = mkdtempSync(join(tmpdir(), 'emperor-linux-outside-'))
    writeFileSync(join(outside, 'sentinel'), 'keep', 'utf8')
    symlinkSync(outside, join(fixture.root, 'tools'))

    await expect(
      fixtureAdapter({
        catalog: fixture.catalog,
        downloader: downloader(archive),
        root: fixture.root,
      }).execute(context('uv', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'integrity_failed' },
    })
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep')
  })

  it.skipIf(process.platform === 'win32')(
    'does not replace an unrelated broken activation symlink',
    async () => {
      const archive = tarGz([
        { name: 'uv', data: Buffer.from('uv'), mode: 0o755 },
        { name: 'uvx', data: Buffer.from('uvx'), mode: 0o755 },
      ])
      const fixture = assetCatalog('uv', {
        id: 'official-archive',
        kind: 'direct_archive',
        url: 'https://github.com/astral-sh/uv/releases/download/fixture/uv.tar.gz',
        sha256: sha256(archive),
        executable: 'uv',
        args: ['--version'],
      })
      const binDir = join(fixture.root, 'home', '.local', 'bin')
      mkdirSync(binDir, { recursive: true })
      const link = join(binDir, 'uv')
      symlinkSync('/outside/missing-uv', link)

      await expect(
        fixtureAdapter({
          catalog: fixture.catalog,
          downloader: downloader(archive),
          root: fixture.root,
        }).execute(context('uv', 'official-archive')),
      ).resolves.toMatchObject({
        status: 'failed',
        error: { environmentCode: 'confirmation_required' },
      })
      expect(readlinkSync(link)).toBe('/outside/missing-uv')
    },
  )

  it('rejects an activation directory that escapes the user home', async () => {
    const archive = tarGz([
      { name: 'uv', data: Buffer.from('uv'), mode: 0o755 },
      { name: 'uvx', data: Buffer.from('uvx'), mode: 0o755 },
    ])
    const fixture = assetCatalog('uv', {
      id: 'official-archive',
      kind: 'direct_archive',
      url: 'https://github.com/astral-sh/uv/releases/download/fixture/uv.tar.gz',
      sha256: sha256(archive),
      executable: 'uv',
      args: ['--version'],
    })
    const home = join(fixture.root, 'home')
    const outside = mkdtempSync(join(tmpdir(), 'emperor-linux-bin-outside-'))
    mkdirSync(home, { recursive: true })
    symlinkSync(outside, join(home, '.local'))

    await expect(
      fixtureAdapter({
        catalog: fixture.catalog,
        downloader: downloader(archive),
        root: fixture.root,
      }).execute(context('uv', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'integrity_failed' },
    })
    expect(existsSync(join(outside, 'bin', 'uv'))).toBe(false)
  })

  it('never overwrites an existing Go executable', async () => {
    const archive = tarGz([
      { name: 'go/bin/go', data: Buffer.from('go'), mode: 0o755 },
    ])
    const fixture = assetCatalog('go', {
      id: 'official-archive',
      kind: 'direct_archive',
      url: 'https://go.dev/dl/go-fixture.linux-amd64.tar.gz',
      sha256: sha256(archive),
      executable: 'go',
      args: ['version'],
    })
    let downloaded = false
    const execution = context('go', 'official-archive')
    const linux = fixtureAdapter({
      catalog: fixture.catalog,
      downloader: {
        download: async () => {
          downloaded = true
        },
      },
      exists: (path) => path === '/usr/local/go/bin/go',
      root: fixture.root,
      envPath: '/usr/local/go/bin:/usr/bin',
    })

    await expect(linux.execute(execution)).resolves.toEqual({
      status: 'awaiting_user',
    })
    expect(downloaded).toBe(false)
    expect(execution.logs[0]).toMatchObject({ kind: 'go_conflict' })
  })

  it('executes a verified rustup binary directly without a remote script', async () => {
    const binary = Buffer.from('rustup-init')
    const fixture = assetCatalog('rustup', {
      id: 'official-binary',
      kind: 'direct_binary',
      url: 'https://static.rust-lang.org/rustup/archive/fixture/rustup-init',
      sha256: sha256(binary),
      executable: 'rustup-init',
      args: [
        '-y',
        '--no-modify-path',
        '--profile',
        'minimal',
        '--default-toolchain',
        '1.97.0',
      ],
    })
    const runner = new FakeRunner()
    const linux = fixtureAdapter({
      catalog: fixture.catalog,
      downloader: downloader(binary),
      runner,
      root: fixture.root,
    })

    await expect(
      linux.execute(context('rustup', 'official-binary')),
    ).resolves.toEqual({ status: 'completed' })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]).toMatchObject({
      executable: expect.stringMatching(/rustup-init$/),
      args: [
        '-y',
        '--no-modify-path',
        '--profile',
        'minimal',
        '--default-toolchain',
        '1.97.0',
      ],
    })
    // Not through a shell. Only the file name counts: the temporary
    // directory's random suffix can contain "sh".
    expect(runner.calls[0]!.executable).not.toMatch(/(^|\/)(ba|z)?sh$/)
  })

  it('reports AppImage FUSE constraints without trying to install them', () => {
    expect(
      linuxAppImageDiagnostics({
        env: { APPIMAGE: '/opt/Emperor.AppImage' },
        pathExists: () => false,
      }),
    ).toEqual(['appimage_fuse_unavailable'])
    expect(
      linuxAppImageDiagnostics({ env: {}, pathExists: () => false }),
    ).toEqual([])
  })
})

function context(
  toolId: EnvironmentToolId,
  strategyId: string,
  opts: { elevation?: boolean } = {},
): EnvironmentStepExecutionContext & {
  logs: Array<{ kind: string; message: string }>
} {
  const logs: Array<{ kind: string; message: string }> = []
  return {
    step: {
      stepId: `step_${toolId}`,
      toolId,
      strategyId,
      dependsOn: [],
      status: 'planned',
      requiresElevation: opts.elevation ?? strategyId === 'apt',
      requiresSeparateConfirmation: false,
    },
    signal: new AbortController().signal,
    log: async (entry) => {
      logs.push({ kind: entry.kind, message: entry.message })
    },
    logs,
  }
}

function fixtureAdapter(
  opts: {
    arch?: 'x64' | 'arm64'
    runner?: EnvironmentProcessRunner
    exists?: (path: string) => boolean
    catalog?: LoadedToolCatalog
    downloader?: AssetDownloader
    root?: string
    osRelease?: string
    envPath?: string
  } = {},
): LinuxEnvironmentAdapter {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'emperor-linux-'))
  const home = join(root, 'home')
  const osRelease = join(root, 'os-release')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    osRelease,
    opts.osRelease ?? 'ID=ubuntu\nVERSION_ID="24.04"\n',
    'utf8',
  )
  return new LinuxEnvironmentAdapter({
    catalog: opts.catalog ?? loadBundledToolCatalog(),
    arch: opts.arch ?? 'x64',
    runner: opts.runner,
    executableExists: opts.exists ?? ((path) => path === '/usr/bin/pkexec'),
    env: {
      HOME: home,
      PATH: opts.envPath ?? '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      API_TOKEN: 'must-not-leak',
    },
    homeDir: home,
    downloader: opts.downloader,
    downloadsDir: join(root, 'downloads'),
    installRoot: join(root, 'tools'),
    osReleasePath: osRelease,
  })
}

function downloader(bytes: Buffer): AssetDownloader {
  return {
    download: async ({ destination }) => {
      writeFileSync(destination, bytes)
    },
  }
}

function assetCatalog(
  toolId: EnvironmentToolId,
  strategy: {
    id: string
    kind: 'direct_archive' | 'direct_binary'
    url: string
    sha256: string
    executable: string
    args: string[]
  },
): { catalog: LoadedToolCatalog; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'emperor-linux-asset-'))
  const catalog = structuredClone(loadBundledToolCatalog())
  const tool = catalog.catalog.tools.find((entry) => entry.id === toolId)!
  tool.strategies = [
    {
      id: strategy.id,
      kind: strategy.kind,
      targets: [{ platform: 'linux', arch: 'x64' }],
      executable: strategy.executable,
      args: strategy.args,
      source: {
        url: strategy.url,
        publisher: 'Official Publisher',
        sha256: strategy.sha256,
      },
      estimatedBytes: 1024,
      requiresElevation: false,
      requiresSeparateConfirmation: false,
    } as unknown as ToolCatalogStrategy,
  ]
  return { catalog, root }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function tarGz(
  entries: Array<{ name: string; data: Buffer; mode?: number }>,
): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644)
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, entry.data.byteLength)
    writeTarOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    writeTarOctal(
      header,
      148,
      8,
      [...header].reduce((sum, byte) => sum + byte, 0),
    )
    blocks.push(header, entry.data)
    const padding = (512 - (entry.data.byteLength % 512)) % 512
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeTarOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  buffer.write(
    `${value.toString(8).padStart(length - 2, '0')}\0 `,
    offset,
    length,
    'ascii',
  )
}
