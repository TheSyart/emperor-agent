import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadBundledToolCatalog,
  type LoadedToolCatalog,
  type ToolCatalogStrategy,
} from './catalog'
import type { EnvironmentStepExecutionContext } from './jobs'
import { MacEnvironmentAdapter, type MacAssetDownloader } from './macos-adapter'
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
  handler:
    ((request: EnvironmentProcessRequest) => EnvironmentProcessResult) | null =
    null

  async run(
    request: EnvironmentProcessRequest,
  ): Promise<EnvironmentProcessResult> {
    this.calls.push(request)
    return this.handler?.(request) ?? this.result
  }
}

function executionContext(
  toolId: EnvironmentToolId,
  strategyId: string,
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
      requiresElevation: false,
      requiresSeparateConfirmation: false,
    },
    signal: new AbortController().signal,
    log: async (entry) => {
      logs.push({ kind: entry.kind, message: entry.message })
    },
    logs,
  }
}

function adapter(
  opts: {
    arch?: 'arm64' | 'x64'
    runner?: EnvironmentProcessRunner
    exists?: (path: string) => boolean
    catalog?: LoadedToolCatalog
    downloader?: MacAssetDownloader
    downloadsDir?: string
  } = {},
): MacEnvironmentAdapter {
  return new MacEnvironmentAdapter({
    catalog: opts.catalog ?? loadBundledToolCatalog(),
    arch: opts.arch ?? 'arm64',
    runner: opts.runner,
    executableExists: opts.exists,
    env: {
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      API_TOKEN: 'must-not-leak',
    },
    homeDir: '/Users/tester',
    downloader: opts.downloader,
    downloadsDir: opts.downloadsDir,
  })
}

describe('MacEnvironmentAdapter', () => {
  it('uses fixed arm64 and x64 Homebrew paths with exact catalog args', async () => {
    const armRunner = new FakeRunner()
    const arm = adapter({
      arch: 'arm64',
      runner: armRunner,
      exists: (path) => path === '/opt/homebrew/bin/brew',
    })
    const x64Runner = new FakeRunner()
    const x64 = adapter({
      arch: 'x64',
      runner: x64Runner,
      exists: (path) => path === '/usr/local/bin/brew',
    })

    await expect(
      arm.execute(executionContext('git', 'homebrew')),
    ).resolves.toEqual({ status: 'completed' })
    await expect(
      x64.execute(executionContext('ripgrep', 'homebrew')),
    ).resolves.toEqual({ status: 'completed' })
    expect(armRunner.calls[0]).toMatchObject({
      executable: '/opt/homebrew/bin/brew',
      args: ['install', 'git'],
      timeoutMs: 30 * 60 * 1_000,
      maxOutputBytes: 1024 * 1024,
    })
    expect(x64Runner.calls[0]).toMatchObject({
      executable: '/usr/local/bin/brew',
      args: ['install', 'ripgrep'],
    })
    expect(armRunner.calls[0]!.env).not.toHaveProperty('API_TOKEN')
    expect(armRunner.calls[0]!.env.PATH).toContain('/opt/homebrew/bin')
  })

  it('does not install Homebrew and offers the Xcode Git flow when brew is absent', async () => {
    const runner = new FakeRunner()
    const mac = adapter({ runner, exists: () => false })
    const context = executionContext('git', 'homebrew')

    await expect(mac.execute(context)).resolves.toEqual({
      status: 'awaiting_user',
    })
    expect(runner.calls).toEqual([
      expect.objectContaining({
        executable: '/usr/bin/xcode-select',
        args: ['--install'],
      }),
    ])
    expect(context.logs).toEqual([
      expect.objectContaining({ kind: 'xcode_command_line_tools_required' }),
    ])
  })

  it('keeps official-guided strategies user-driven and never invokes a shell', async () => {
    const runner = new FakeRunner()
    const mac = adapter({ runner })
    const context = executionContext('go', 'official-guided')

    await expect(mac.execute(context)).resolves.toEqual({
      status: 'awaiting_user',
    })
    expect(runner.calls).toEqual([])
    expect(context.logs[0]).toMatchObject({ kind: 'official_install_required' })
  })

  it('runs version-manager strategies with the exact catalog command', async () => {
    const runner = new FakeRunner()
    const mac = adapter({
      runner,
      exists: (path) => path === '/Users/tester/.volta/bin/volta',
    })

    await expect(
      mac.execute(executionContext('node', 'volta')),
    ).resolves.toEqual({ status: 'completed' })
    expect(runner.calls[0]).toMatchObject({
      executable: '/Users/tester/.volta/bin/volta',
      args: ['install', 'node@24.18.0'],
    })
  })

  it('maps a declined Xcode system flow to elevation_declined', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, exitCode: 1, stderr: 'user cancelled' }
    const mac = adapter({ runner, exists: () => false })

    await expect(
      mac.execute(executionContext('git', 'homebrew')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'elevation_declined' },
    })
  })

  it('maps process cancellation without converting it to installer failure', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, status: 'cancelled', exitCode: null }
    const mac = adapter({
      runner,
      exists: (path) => path === '/opt/homebrew/bin/brew',
    })

    await expect(
      mac.execute(executionContext('ripgrep', 'homebrew')),
    ).resolves.toEqual({ status: 'cancelled' })
  })

  it('rejects a pkg digest mismatch before checking or opening the installer', async () => {
    const runner = new FakeRunner()
    const downloadsDir = mkdtempSync(join(tmpdir(), 'emperor-mac-download-'))
    const bytes = Buffer.from('tampered package')
    const catalog = catalogWithPkg({
      sha256: createHash('sha256').update('expected package').digest('hex'),
      publisher: 'Example Corporation',
    })
    const downloader: MacAssetDownloader = {
      download: async ({ destination }) => {
        writeFileSync(destination, bytes)
      },
    }
    const mac = adapter({ catalog, runner, downloader, downloadsDir })

    const result = await mac.execute(executionContext('git', 'official-pkg'))

    expect(result).toMatchObject({
      status: 'failed',
      error: { environmentCode: 'integrity_failed' },
    })
    expect(runner.calls).toEqual([])
  })

  it('verifies pkg publisher before opening the trusted installer for user approval', async () => {
    const runner = new FakeRunner()
    const downloadsDir = mkdtempSync(join(tmpdir(), 'emperor-mac-download-'))
    const bytes = Buffer.from('signed package')
    const publisher = 'Example Corporation'
    const catalog = catalogWithPkg({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      publisher,
    })
    runner.handler = (request) =>
      request.executable === '/usr/sbin/pkgutil'
        ? {
            ...runner.result,
            stdout: `Status: signed by a certificate trusted by macOS\nDeveloper ID Installer: ${publisher} (TEAMID)`,
          }
        : runner.result
    const downloader: MacAssetDownloader = {
      download: async ({ destination }) => {
        writeFileSync(destination, bytes)
      },
    }
    const mac = adapter({ catalog, runner, downloader, downloadsDir })

    await expect(
      mac.execute(executionContext('git', 'official-pkg')),
    ).resolves.toEqual({ status: 'awaiting_user' })
    expect(runner.calls.map((call) => [call.executable, call.args[0]])).toEqual(
      [
        ['/usr/sbin/pkgutil', '--check-signature'],
        ['/usr/bin/open', expect.stringContaining('step_git-')],
      ],
    )
  })

  it('rejects a mismatched pkg publisher without opening it', async () => {
    const runner = new FakeRunner()
    const downloadsDir = mkdtempSync(join(tmpdir(), 'emperor-mac-download-'))
    const bytes = Buffer.from('signed package')
    const catalog = catalogWithPkg({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      publisher: 'Expected Corporation',
    })
    runner.result = {
      ...runner.result,
      stdout:
        'Status: signed by a certificate trusted by macOS\nDeveloper ID Installer: Unexpected Corporation (OTHER)',
    }
    const mac = adapter({
      catalog,
      runner,
      downloadsDir,
      downloader: {
        download: async ({ destination }) => {
          writeFileSync(destination, bytes)
        },
      },
    })

    const result = await mac.execute(executionContext('git', 'official-pkg'))

    expect(result).toMatchObject({
      status: 'failed',
      error: { environmentCode: 'publisher_mismatch' },
    })
    expect(runner.calls).toHaveLength(1)
  })

  it('opens an official archive only after its fixed digest is verified', async () => {
    const runner = new FakeRunner()
    const downloadsDir = mkdtempSync(join(tmpdir(), 'emperor-mac-download-'))
    const bytes = Buffer.from('official archive')
    const catalog = catalogWithArchive(
      createHash('sha256').update(bytes).digest('hex'),
    )
    const mac = adapter({
      catalog,
      runner,
      downloadsDir,
      downloader: {
        download: async ({ destination }) => {
          writeFileSync(destination, bytes)
        },
      },
    })

    await expect(
      mac.execute(executionContext('git', 'official-archive')),
    ).resolves.toEqual({ status: 'awaiting_user' })
    expect(runner.calls).toEqual([
      expect.objectContaining({
        executable: '/usr/bin/open',
        args: [expect.stringMatching(/step_git-.+\.zip$/)],
      }),
    ])
  })
})

function catalogWithPkg(opts: {
  sha256: string
  publisher: string
}): LoadedToolCatalog {
  const base = structuredClone(loadBundledToolCatalog())
  const git = base.catalog.tools.find((tool) => tool.id === 'git')!
  const strategy: ToolCatalogStrategy = {
    id: 'official-pkg',
    kind: 'macos_installer',
    targets: [{ platform: 'darwin', arch: 'arm64' }],
    executable: '/usr/bin/open',
    args: [],
    source: {
      url: 'https://downloads.example.test/tool.pkg',
      publisher: opts.publisher,
      sha256: opts.sha256,
    },
    estimatedBytes: 1024,
    requiresElevation: true,
    requiresSeparateConfirmation: true,
  }
  git.strategies = [strategy]
  return base
}

function catalogWithArchive(sha256: string): LoadedToolCatalog {
  const base = structuredClone(loadBundledToolCatalog())
  const git = base.catalog.tools.find((tool) => tool.id === 'git')!
  git.strategies = [
    {
      id: 'official-archive',
      kind: 'direct_archive',
      targets: [{ platform: 'darwin', arch: 'arm64' }],
      executable: '/usr/bin/open',
      args: [],
      source: {
        url: 'https://downloads.example.test/tool.zip',
        publisher: 'Example Corporation',
        sha256,
      },
      estimatedBytes: 1024,
      requiresElevation: false,
      requiresSeparateConfirmation: true,
    },
  ]
  return base
}
