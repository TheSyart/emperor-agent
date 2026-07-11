import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
} from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type {
  LoadedToolCatalog,
  ToolCatalogEntry,
  ToolCatalogStrategy,
} from './catalog'
import {
  NodeHttpsAssetDownloader,
  type AssetDownloadRequest,
  type AssetDownloader,
} from './download'
import { EnvironmentError } from './errors'
import type {
  EnvironmentStepExecutionContext,
  EnvironmentStepExecutionResult,
  EnvironmentStepExecutor,
} from './jobs'
import type { EnvironmentArch } from './models'
import { buildEffectivePath } from './path'
import {
  NodeEnvironmentProcessRunner,
  type EnvironmentProcessRequest,
  type EnvironmentProcessResult,
  type EnvironmentProcessRunner,
} from './process-runner'

const INSTALL_TIMEOUT_MS = 30 * 60 * 1_000
const VERIFY_TIMEOUT_MS = 30_000
const MAX_INSTALL_OUTPUT_BYTES = 1024 * 1024

export type MacAssetDownloadRequest = AssetDownloadRequest
export type MacAssetDownloader = AssetDownloader

export interface MacEnvironmentAdapterOptions {
  catalog: LoadedToolCatalog
  arch: EnvironmentArch
  runner?: EnvironmentProcessRunner
  env?: Record<string, string | undefined>
  homeDir?: string
  executableExists?: (path: string) => boolean
  downloader?: MacAssetDownloader | null
  downloadsDir?: string | null
}

export class MacEnvironmentAdapter implements EnvironmentStepExecutor {
  private readonly catalog: LoadedToolCatalog
  private readonly arch: EnvironmentArch
  private readonly runner: EnvironmentProcessRunner
  private readonly env: Record<string, string | undefined>
  private readonly homeDir: string
  private readonly executableExists: (path: string) => boolean
  private readonly downloader: MacAssetDownloader | null
  private readonly downloadsDir: string | null

  constructor(opts: MacEnvironmentAdapterOptions) {
    this.catalog = opts.catalog
    this.arch = opts.arch
    this.runner = opts.runner ?? new NodeEnvironmentProcessRunner()
    this.env = { ...(opts.env ?? process.env) }
    this.homeDir = opts.homeDir ?? this.env.HOME ?? ''
    this.executableExists = opts.executableExists ?? isExecutable
    this.downloader = opts.downloader ?? new NodeHttpsAssetDownloader()
    this.downloadsDir = opts.downloadsDir ?? null
  }

  async execute(
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    const resolved = this.resolveStep(context)
    if (!resolved)
      return failed(new EnvironmentError('unsupported_requirement'))
    const { tool, strategy } = resolved
    if (strategy.kind === 'system_prompt') {
      await context.log({
        level: 'info',
        kind: 'official_install_required',
        message: `${tool.id} requires installation from its official source.`,
        details: {
          source: strategy.source.url,
          publisher: strategy.source.publisher,
        },
      })
      return { status: 'awaiting_user' }
    }
    if (strategy.kind === 'macos_installer')
      return await this.installPackage(strategy, context)
    if (strategy.kind === 'direct_archive')
      return await this.openVerifiedArchive(strategy, context)
    if (strategy.kind === 'package_manager')
      return await this.runPackageManager(tool, strategy, context)
    if (strategy.kind === 'version_manager' || strategy.kind === 'bundled')
      return await this.runCatalogCommand(strategy, context)
    return failed(new EnvironmentError('unsupported_requirement'))
  }

  private resolveStep(
    context: EnvironmentStepExecutionContext,
  ): { tool: ToolCatalogEntry; strategy: ToolCatalogStrategy } | null {
    const tool = this.catalog.catalog.tools.find(
      (candidate) => candidate.id === context.step.toolId,
    )
    const strategy = tool?.strategies.find(
      (candidate) =>
        candidate.id === context.step.strategyId &&
        candidate.targets.some(
          (target) => target.platform === 'darwin' && target.arch === this.arch,
        ),
    )
    return tool && strategy ? { tool, strategy } : null
  }

  private async runPackageManager(
    tool: ToolCatalogEntry,
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (strategy.id !== 'homebrew' || strategy.executable !== 'brew')
      return failed(new EnvironmentError('unsupported_requirement'))
    const executable =
      this.arch === 'arm64' ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew'
    if (!this.executableExists(executable)) {
      await context.log({
        level: 'warn',
        kind:
          tool.id === 'git'
            ? 'xcode_command_line_tools_required'
            : 'homebrew_required',
        message:
          tool.id === 'git'
            ? 'Homebrew is unavailable; install Git through Xcode Command Line Tools or Homebrew.'
            : 'Homebrew is unavailable and will not be installed automatically.',
        details: { toolId: tool.id },
      })
      if (tool.id === 'git') {
        const requested = await this.runner.run({
          executable: '/usr/bin/xcode-select',
          args: ['--install'],
          env: this.processEnvironment(),
          timeoutMs: VERIFY_TIMEOUT_MS,
          maxOutputBytes: 256 * 1024,
          signal: context.signal,
        })
        if (requested.status === 'cancelled') return { status: 'cancelled' }
        if (requested.status !== 'completed')
          return failed(new EnvironmentError('installer_failed'))
        if (requested.exitCode !== 0)
          return failed(new EnvironmentError('elevation_declined'))
      }
      return { status: 'awaiting_user' }
    }
    return await this.runProcess(
      {
        executable,
        args: [...strategy.args],
        env: this.processEnvironment(),
        timeoutMs: INSTALL_TIMEOUT_MS,
        maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
        signal: context.signal,
      },
      context,
    )
  }

  private async runCatalogCommand(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    const executable = this.resolveExecutable(strategy.executable)
    if (!executable)
      return failed(new EnvironmentError('post_install_probe_failed'))
    return await this.runProcess(
      {
        executable,
        args: [...strategy.args],
        env: this.processEnvironment(),
        timeoutMs: INSTALL_TIMEOUT_MS,
        maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
        signal: context.signal,
      },
      context,
    )
  }

  private async runProcess(
    request: EnvironmentProcessRequest,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    const result = await this.runner.run(request)
    await logProcessResult(context, result)
    if (result.status === 'cancelled') return { status: 'cancelled' }
    if (result.status !== 'completed' || result.exitCode !== 0)
      return failed(new EnvironmentError('installer_failed'))
    return { status: 'completed' }
  }

  private async installPackage(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (!strategy.source.sha256 || !this.downloader || !this.downloadsDir)
      return failed(new EnvironmentError('download_failed'))
    await mkdir(this.downloadsDir, { recursive: true })
    const destination = join(
      this.downloadsDir,
      `${context.step.stepId}-${strategy.source.sha256.slice(0, 16)}.pkg`,
    )
    await rm(destination, { force: true })
    try {
      await this.downloader.download({
        url: strategy.source.url,
        destination,
        maxBytes: boundedDownloadBytes(strategy.estimatedBytes),
        signal: context.signal,
      })
    } catch (error) {
      if (context.signal.aborted) return { status: 'cancelled' }
      return failed(
        error instanceof EnvironmentError
          ? error
          : new EnvironmentError('download_failed', { cause: error }),
      )
    }
    if (!safeRegularFile(destination))
      return failed(new EnvironmentError('integrity_failed'))
    const digest = await sha256File(destination)
    if (digest !== strategy.source.sha256) {
      await rm(destination, { force: true })
      return failed(new EnvironmentError('integrity_failed'))
    }
    const signature = await this.runner.run({
      executable: '/usr/sbin/pkgutil',
      args: ['--check-signature', destination],
      env: this.processEnvironment(),
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      signal: context.signal,
    })
    if (signature.status === 'cancelled') return { status: 'cancelled' }
    if (
      signature.status !== 'completed' ||
      signature.exitCode !== 0 ||
      !trustedPackagePublisher(
        `${signature.stdout}\n${signature.stderr}`,
        strategy.source.publisher,
      )
    ) {
      await rm(destination, { force: true })
      return failed(new EnvironmentError('publisher_mismatch'))
    }
    const opened = await this.runner.run({
      executable: '/usr/bin/open',
      args: [destination],
      env: this.processEnvironment(),
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      signal: context.signal,
    })
    if (opened.status === 'cancelled') return { status: 'cancelled' }
    if (opened.status !== 'completed' || opened.exitCode !== 0)
      return failed(new EnvironmentError('installer_failed'))
    await context.log({
      level: 'info',
      kind: 'macos_installer_opened',
      message: 'A verified macOS installer is awaiting user approval.',
      details: { publisher: strategy.source.publisher },
    })
    return { status: 'awaiting_user' }
  }

  private async openVerifiedArchive(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    const destination = await this.downloadVerifiedAsset(
      strategy,
      context,
      archiveExtension(strategy.source.url),
    )
    if (typeof destination !== 'string') return destination
    const opened = await this.runner.run({
      executable: '/usr/bin/open',
      args: [destination],
      env: this.processEnvironment(),
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      signal: context.signal,
    })
    if (opened.status === 'cancelled') return { status: 'cancelled' }
    if (opened.status !== 'completed' || opened.exitCode !== 0)
      return failed(new EnvironmentError('installer_failed'))
    await context.log({
      level: 'info',
      kind: 'macos_archive_opened',
      message: 'A digest-verified official archive is awaiting user review.',
      details: { publisher: strategy.source.publisher },
    })
    return { status: 'awaiting_user' }
  }

  private async downloadVerifiedAsset(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
    extension: string,
  ): Promise<string | EnvironmentStepExecutionResult> {
    if (!strategy.source.sha256 || !this.downloader || !this.downloadsDir)
      return failed(new EnvironmentError('download_failed'))
    await mkdir(this.downloadsDir, { recursive: true })
    const destination = join(
      this.downloadsDir,
      `${context.step.stepId}-${strategy.source.sha256.slice(0, 16)}${extension}`,
    )
    await rm(destination, { force: true })
    try {
      await this.downloader.download({
        url: strategy.source.url,
        destination,
        maxBytes: boundedDownloadBytes(strategy.estimatedBytes),
        signal: context.signal,
      })
    } catch (error) {
      if (context.signal.aborted) return { status: 'cancelled' }
      return failed(
        error instanceof EnvironmentError
          ? error
          : new EnvironmentError('download_failed', { cause: error }),
      )
    }
    if (!safeRegularFile(destination))
      return failed(new EnvironmentError('integrity_failed'))
    if ((await sha256File(destination)) !== strategy.source.sha256) {
      await rm(destination, { force: true })
      return failed(new EnvironmentError('integrity_failed'))
    }
    return destination
  }

  private resolveExecutable(executable: string): string | null {
    if (posix.isAbsolute(executable))
      return this.executableExists(executable) ? executable : null
    for (const directory of this.effectivePath().entries) {
      const candidate = posix.join(directory, executable)
      if (this.executableExists(candidate)) return candidate
    }
    return null
  }

  private effectivePath(): { entries: string[]; value: string } {
    return buildEffectivePath({
      platform: 'darwin',
      envPath: this.env.PATH,
      homeDir: this.homeDir,
      windowsEnv: this.env,
    })
  }

  private processEnvironment(): Record<string, string> {
    const output: Record<string, string> = {
      HOME: this.homeDir,
      PATH: this.effectivePath().value,
    }
    for (const name of [
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'TEMP',
      'TMP',
      'TERM',
      'USER',
    ]) {
      const value = this.env[name]
      if (value !== undefined) output[name] = value
    }
    return output
  }
}

function failed(error: EnvironmentError): EnvironmentStepExecutionResult {
  return { status: 'failed', error }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function safeRegularFile(path: string): boolean {
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  return stat.isFile() && !stat.isSymbolicLink()
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function trustedPackagePublisher(output: string, publisher: string): boolean {
  const escaped = publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^\\s*(?:[0-9]+\\.\\s*)?Developer ID Installer:\\s*${escaped}(?:\\s*\\([^\\r\\n]+\\))?\\s*$`,
    'im',
  ).test(output)
}

function boundedDownloadBytes(estimatedBytes: number): number {
  return Math.min(
    20_000_000_000,
    Math.max(20 * 1024 * 1024, estimatedBytes + 10 * 1024 * 1024),
  )
}

function archiveExtension(sourceUrl: string): string {
  const path = new URL(sourceUrl).pathname.toLowerCase()
  if (path.endsWith('.tar.gz')) return '.tar.gz'
  if (path.endsWith('.tgz')) return '.tgz'
  if (path.endsWith('.zip')) return '.zip'
  return '.archive'
}

async function logProcessResult(
  context: EnvironmentStepExecutionContext,
  result: EnvironmentProcessResult,
): Promise<void> {
  await context.log({
    level:
      result.status === 'completed' && result.exitCode === 0 ? 'info' : 'error',
    kind: 'installer_process',
    message: `Installer process ${result.status}.`,
    details: {
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  })
}
