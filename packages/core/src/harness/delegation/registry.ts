import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  DelegationError,
  type ExecutorProfile,
  type ExternalBackend,
  type ExecutorCapabilities,
  type ExecutorProbe,
} from './types'
const run = promisify(execFile)
export class ExecutorRegistry {
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
  async probe(
    profile: ExecutorProfile,
    signal?: AbortSignal,
  ): Promise<ExecutorProbe> {
    const base = {
      capabilities: this.capabilities(profile.backend),
      checkedAt: Date.now(),
      authVerified: false,
    }
    try {
      const { stdout } = await run(profile.executablePath, ['--version'], {
        timeout: 5000,
        maxBuffer: 4096,
        signal,
        shell: false,
      })
      const version = stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
      const supported = profile.backend === 'codex' ? '0.153.4' : '2.1.281'
      if (
        !version ||
        version !== profile.expectedVersion ||
        profile.expectedVersion !== supported
      )
        return {
          ...base,
          status: 'incompatible',
          ...(version ? { executableVersion: version } : {}),
          diagnostic: 'binary version is outside the pinned protocol baseline',
        }
      return {
        ...base,
        status: 'available',
        executableVersion: version,
        ...(profile.backend === 'claude-code' ? { sdkVersion: '0.3.281' } : {}),
      }
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
