import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { executorEnvironment } from './environment'
import {
  CLAUDE_REQUIRED_RANGE,
  CLAUDE_SDK_VERSION,
  KNOWN_CODEX_PROTOCOLS,
  claudeVersionSupported,
  codexProtocolDigest,
  codexProtocolsFor,
  codexRequiredRange,
  formatVersion,
  parseVersion,
  type CodexProtocol,
} from './compatibility'
import {
  bundledClaudeExecutable,
  claudeExecutableSource,
  executorExecutable,
} from './executable'
import {
  DelegationError,
  ExecutorAuthError,
  type ExecutorAuthState,
  type ExecutorProfile,
  type ExternalBackend,
  type ExecutorCapabilities,
  type ExecutorProbe,
} from './types'
const run = promisify(execFile)
export class ExecutorRegistry {
  /** Protocol digests by binary identity; generating a schema is not free. */
  private readonly digests = new Map<string, string | undefined>()
  constructor(
    private readonly options: {
      home?: string
      environment?: NodeJS.ProcessEnv
      /** Test hook: where the SDK-bundled claude lives. */
      bundledClaude?: () => string | undefined
      /** Test hook: the verified Codex protocols. */
      codexProtocols?: readonly CodexProtocol[]
    } = {},
  ) {}
  capabilities(backend: ExternalBackend): ExecutorCapabilities {
    return {
      persistentSession: true,
      queuedFollowup: true,
      steer: backend === 'codex',
      interrupt: true,
      questions: true,
      structuredOutput: true,
      processBoundary: process.platform === 'win32' ? 'none' : 'os',
      usage: backend === 'claude-code' ? 'tokens-and-estimate' : 'tokens',
    }
  }
  private environment(): NodeJS.ProcessEnv {
    return executorEnvironment(this.options.environment, this.options.home)
  }
  async probe(
    profile: ExecutorProfile,
    signal?: AbortSignal,
  ): Promise<ExecutorProbe> {
    const source = claudeExecutableSource(profile)
    const base = {
      capabilities: this.capabilities(profile.backend),
      checkedAt: Date.now(),
      authVerified: false,
      ...(source ? { executableSource: source } : {}),
    }
    let executable: string
    try {
      executable = executorExecutable(
        profile,
        this.options.bundledClaude ?? bundledClaudeExecutable,
      )
    } catch (error) {
      return {
        ...base,
        status: 'missing',
        diagnostic: (error as Error).message.replace(/^EXECUTOR_MISSING: /, ''),
      }
    }
    let stdout: string
    try {
      stdout = (
        await run(executable, ['--version'], {
          timeout: 5000,
          maxBuffer: 4096,
          signal,
          shell: false,
          env: this.environment(),
        })
      ).stdout
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        ...base,
        status: code === 'ENOENT' ? 'missing' : 'incompatible',
        diagnostic:
          code === 'ENOENT'
            ? 'executor binary not found'
            : 'executor version probe failed',
      }
    }
    const version = parseVersion(stdout)
    if (!version)
      return {
        ...base,
        status: 'incompatible',
        diagnostic: 'executor did not report a version',
      }
    const executableVersion = formatVersion(version)
    if (profile.backend === 'claude-code') {
      if (!claudeVersionSupported(version))
        return {
          ...base,
          status: 'incompatible',
          executableVersion,
          requiredVersion: CLAUDE_REQUIRED_RANGE,
          diagnostic: `Claude Code ${executableVersion} is older than the supported ${CLAUDE_REQUIRED_RANGE}`,
        }
      return {
        ...base,
        status: 'available',
        executableVersion,
        sdkVersion: CLAUDE_SDK_VERSION,
        requiredVersion: CLAUDE_REQUIRED_RANGE,
      }
    }
    const protocols = this.options.codexProtocols ?? KNOWN_CODEX_PROTOCOLS
    const requiredVersion = codexRequiredRange(protocols)
    const candidates = codexProtocolsFor(version, protocols)
    if (!candidates.length)
      return {
        ...base,
        status: 'incompatible',
        executableVersion,
        requiredVersion,
        diagnostic: `Codex ${executableVersion} is outside the supported ${requiredVersion}`,
      }
    const digests = await this.codexDigests(
      executable,
      executableVersion,
      candidates,
      signal,
    )
    const verified = candidates.find((p, i) => {
      const digest = digests?.[i]
      return digest !== undefined && p.digests.includes(digest)
    })
    if (verified)
      return {
        ...base,
        status: 'available',
        executableVersion,
        requiredVersion,
        compatibility: 'verified',
        protocolVersion: verified.version,
      }
    const nearest = candidates[0]!
    return {
      ...base,
      status: 'available',
      executableVersion,
      requiredVersion,
      compatibility: 'unverified',
      protocolVersion: nearest.version,
      diagnostic: `Codex ${executableVersion} speaks a protocol that differs from the verified Codex ${nearest.version}; it may be incompatible`,
    }
  }
  /**
   * The generated schema's digest over each candidate's file list (aligned
   * with `candidates`); undefined when the schema cannot be generated.
   */
  private async codexDigests(
    executable: string,
    version: string,
    candidates: CodexProtocol[],
    signal?: AbortSignal,
  ): Promise<(string | undefined)[] | undefined> {
    let identity: string
    try {
      const stat = statSync(executable)
      identity = [executable, stat.ino, stat.size, stat.mtimeMs].join('\0')
    } catch {
      // A bare command name resolved through PATH: the version still counts.
      identity = executable
    }
    const keys = candidates.map((p) =>
      [identity, version, ...p.files].join('\0'),
    )
    if (keys.every((key) => this.digests.has(key)))
      return keys.map((key) => this.digests.get(key))
    const root = mkdtempSync(join(tmpdir(), 'emperor-codex-schema-'))
    try {
      // A private CODEX_HOME: generating the schema reads no user config and
      // makes no model call.
      mkdirSync(join(root, 'home'))
      await run(
        executable,
        ['app-server', 'generate-json-schema', '--out', join(root, 'out')],
        {
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          signal,
          shell: false,
          env: { ...this.environment(), CODEX_HOME: join(root, 'home') },
        },
      )
      const read = (file: string) => {
        try {
          return readFileSync(join(root, 'out', file), 'utf8')
        } catch {
          return undefined
        }
      }
      return candidates.map((p, i) => {
        const digest = codexProtocolDigest(read, p.files)
        this.digests.set(keys[i]!, digest)
        return digest
      })
    } catch {
      return undefined
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  async requireAvailable(
    profile: ExecutorProfile,
    signal?: AbortSignal,
  ): Promise<ExecutorProbe> {
    if (!profile.enabled)
      throw new DelegationError(
        'EXECUTOR_DISABLED',
        'enable the executor profile before delegation',
      )
    const result = await this.probe(profile, signal)
    if (result.status !== 'available')
      throw new DelegationError(
        result.status === 'missing'
          ? 'EXECUTOR_MISSING'
          : 'EXECUTOR_INCOMPATIBLE',
        result.diagnostic ?? result.status,
      )
    return result
  }
}
/**
 * The sign-in check that goes with an available probe (AGT-02): without a
 * usable credential the executor is `needs_auth`, with what the check
 * found; the error is returned for a caller that has to fail with it.
 */
export async function checkSignIn(
  probe: ExecutorProbe,
  check: () => Promise<ExecutorAuthState | undefined>,
): Promise<{ probe: ExecutorProbe; error?: unknown }> {
  if (probe.status !== 'available') return { probe }
  try {
    const auth = await check()
    return {
      probe: { ...probe, localAuthChecked: true, ...(auth && { auth }) },
    }
  } catch (error) {
    const code = error instanceof DelegationError ? error.code : undefined
    return {
      error,
      probe: {
        ...probe,
        localAuthChecked: false,
        status:
          code === 'AUTH_REQUIRED' || code === 'AUTH_EXPIRED'
            ? 'needs_auth'
            : 'incompatible',
        diagnostic: code ?? 'AUTH_ROUTE_UNAVAILABLE',
        ...(error instanceof ExecutorAuthError && { auth: error.auth }),
      },
    }
  }
}
