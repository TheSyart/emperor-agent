import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DelegationError, type ExecutorProfile } from './types'

export type ClaudeExecutableSource = 'bundled' | 'system'

/** Claude Code runs the SDK-bundled binary unless the user chose otherwise. */
export function claudeExecutableSource(
  profile: Pick<ExecutorProfile, 'backend' | 'executableSource'>,
): ClaudeExecutableSource | undefined {
  if (profile.backend !== 'claude-code') return undefined
  return profile.executableSource === 'system' ? 'system' : 'bundled'
}

const SDK = '@anthropic-ai/claude-agent-sdk'

/** Packaged files under app.asar are executed from app.asar.unpacked. */
function unpacked(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/**
 * The `claude` binary that ships with the Agent SDK for this platform, as
 * the SDK itself would find it, or undefined when it is not installed.
 */
export function bundledClaudeExecutable(
  options: {
    platform?: NodeJS.Platform
    arch?: string
    resourcesPath?: string
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const binary = `${SDK}-${platform}-${arch}/claude${platform === 'win32' ? '.exe' : ''}`
  const candidates: string[] = []
  const resources =
    options.resourcesPath ??
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources)
    for (const prefix of ['', `${SDK}/node_modules/`])
      candidates.push(
        join(resources, 'app.asar.unpacked', 'node_modules', prefix + binary),
      )
  const requires: NodeJS.Require[] = []
  try {
    // CommonJS bundles (the Electron e2e harness) have no import.meta.url.
    if (import.meta.url) requires.push(createRequire(import.meta.url))
  } catch {
    /* fall through to the working directory */
  }
  try {
    requires.push(createRequire(join(process.cwd(), 'package.json')))
  } catch {
    /* no resolvable working directory */
  }
  for (const require of requires) {
    try {
      // Resolve from the SDK's own location, as its launcher does.
      candidates.push(createRequire(require.resolve(SDK)).resolve(binary))
    } catch {
      /* SDK or its platform package is not installed here */
    }
    try {
      candidates.push(require.resolve(binary))
    } catch {
      /* not hoisted next to this module */
    }
  }
  return candidates.map(unpacked).find((path) => existsSync(path))
}

/** The executable a profile launches; the bundled Claude must be present. */
export function executorExecutable(
  profile: ExecutorProfile,
  bundled: () => string | undefined = bundledClaudeExecutable,
): string {
  if (claudeExecutableSource(profile) !== 'bundled')
    return profile.executablePath
  const path = bundled()
  if (!path)
    throw new DelegationError(
      'EXECUTOR_MISSING',
      'the Claude Code bundled with Emperor is missing; reinstall Emperor or switch to the installed claude',
    )
  return path
}
