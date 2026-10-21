import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexAuthWritableFile } from './codex-auth'
import type { CodexAuthLink } from './types'
import { buildEffectivePath, windowsEnvValue } from '../../environment/path'

// Finder/LaunchServices does not inherit the interactive shell's PATH. Use the
// same application tool locations for discovery and the isolated CLI runtime.
export function executorEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): NodeJS.ProcessEnv {
  const environment = { ...ambient }
  const path = buildEffectivePath({
    platform:
      process.platform === 'darwin' || process.platform === 'win32'
        ? process.platform
        : 'linux',
    envPath: windowsEnvValue(ambient, 'PATH'),
    homeDir: home,
    windowsEnv: ambient,
  }).value
  for (const key of Object.keys(environment))
    if (key.toUpperCase() === 'PATH') delete environment[key]
  return { ...environment, PATH: path }
}

/**
 * What an external run may write beyond its workspace and temp folder: its
 * state roots (its own folder; Claude Code's dedicated config and home,
 * AGT-12), the user's Codex auth.json behind the isolated link (AGT-03),
 * and Claude Code's own login file, which the protected-path table closes
 * to everything else.
 */
export function executorGrants(runtime: {
  runtimeRoot: string
  stateRoots?: readonly string[]
  environment: Record<string, string>
  codexAuth?: CodexAuthLink
}): { runtimeStateRoots: string[]; writableFiles?: string[] } {
  const files = [
    ...(runtime.codexAuth ? [codexAuthWritableFile(runtime.codexAuth)] : []),
    ...(runtime.environment.CLAUDE_CONFIG_DIR
      ? [join(runtime.environment.CLAUDE_CONFIG_DIR, '.credentials.json')]
      : []),
  ]
  return {
    runtimeStateRoots: [...(runtime.stateRoots ?? [runtime.runtimeRoot])],
    ...(files.length ? { writableFiles: files } : {}),
  }
}
