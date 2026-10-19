/**
 * Plugin hooks in the process containment (SEC-08, with SEC-07): a plugin's
 * command hook runs `/bin/sh -c <command>` through the owned process runtime
 * and the same containment as the Shell and MCP servers — the workspace
 * readable but not writable, the plugin's package readable, its data folder
 * (`plugins/data/<id>`) and temp folder (`plugins/tmp/<id>`) writable,
 * Emperor Home and the user's credentials closed, network allowed. With no
 * sandbox the hook does not run (a non-blocking hook error). The user's own
 * `hooks.json` hooks are trusted and keep running directly (runner.ts).
 */

import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { OwnedProcessRuntime } from '../../processes/runtime'
import type { ContainmentPolicy } from '../../sandbox/policy'
import { processContainmentPolicy } from '../../sandbox/presets'
import { parseHookOutput } from './codec'
import type { RunHookOptions, RunHookResult } from './runner'
import type { CommandHook } from './types'

/** Where a plugin hook comes from: its plugin, package and data folder. */
export interface PluginHookSource {
  readonly pluginId: string
  readonly root: string | null
  readonly data: string | null
}

/** Runs one plugin hook; the host passes the contained runner. */
export type PluginHookRunner = (
  hook: CommandHook,
  options: RunHookOptions & { sessionId?: string | null },
  source: PluginHookSource,
) => Promise<RunHookResult>

/** Captured stdout / stderr per stream, as the direct runner keeps them. */
const MAX_CAPTURE_BYTES = 1024 * 1024

function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** The temp folder of one plugin's hooks, beside its data folder. */
export function pluginHookTempDirectory(
  stateRoot: string,
  pluginId: string,
): string {
  return join(
    real(resolve(stateRoot)),
    'plugins',
    'tmp',
    ...pluginId.split('/'),
  )
}

export function pluginHookContainment(input: {
  stateRoot: string
  home?: string
  source: PluginHookSource
  workspace: string
  env: Readonly<Record<string, string | undefined>>
}): ContainmentPolicy {
  const tempDir = pluginHookTempDirectory(
    input.stateRoot,
    input.source.pluginId,
  )
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  if (input.source.data)
    mkdirSync(input.source.data, { recursive: true, mode: 0o700 })
  return processContainmentPolicy({
    workspace: { root: input.workspace, access: 'read' },
    stateRoot: input.stateRoot,
    read: input.source.root ? [input.source.root] : [],
    write: input.source.data ? [input.source.data] : [],
    tempDir,
    network: 'allow',
    fallback: 'refuse',
    executables: ['/bin/sh'],
    env: input.env,
    home: input.home ?? homedir(),
    desktop: 'deny',
  })
}

/** The host's plugin hook runner over the owned process runtime. */
export function containedPluginHookRunner(deps: {
  runtime: OwnedProcessRuntime
  stateRoot: string
  /** The home folder of the credential table; defaults to the user's. */
  home?: string
  /** The environment hooks start from (SEC-07 narrows it). */
  env?: () => Readonly<Record<string, string | undefined>>
}): PluginHookRunner {
  return async (hook, options, source) => {
    const started = performance.now()
    const timeoutMs =
      hook.timeoutSec !== undefined && hook.timeoutSec > 0
        ? hook.timeoutSec * 1000
        : options.defaultTimeoutMs
    const base = deps.env?.() ?? process.env
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries({ ...base, ...options.env }))
      if (value !== undefined) env[key] = value
    const workspace = options.cwd ?? process.cwd()
    const done = (
      exitCode: number | undefined,
      stdout: string,
      stderr: string,
    ) => ({
      output: parseHookOutput(
        exitCode,
        stdout,
        stderr,
        exitCode === undefined ? undefined : options.expectedEventName,
      ),
      durationMs: Math.max(0, performance.now() - started),
    })
    if (options.signal.aborted)
      return done(undefined, '', 'hook cancelled before start')
    let policy: ContainmentPolicy
    try {
      policy = pluginHookContainment({
        stateRoot: deps.stateRoot,
        ...(deps.home ? { home: deps.home } : {}),
        source,
        workspace,
        env,
      })
    } catch (error) {
      return done(undefined, '', `hook could not start: ${String(error)}`)
    }
    const result = await deps.runtime.run({
      executable: '/bin/sh',
      args: ['-c', hook.command],
      cwd: workspace,
      env,
      stdin:
        JSON.stringify(options.payload ?? null) +
        (options.trailingNewline ? '\n' : ''),
      timeoutMs,
      signal: options.signal,
      maxOutputBytes: MAX_CAPTURE_BYTES,
      outputPolicy: 'truncate_tail',
      outputQuotaScope: 'per_stream',
      owner: {
        kind: 'hook',
        id: source.pluginId,
        sessionId: options.sessionId ?? null,
      },
      execution: { kind: 'sandbox', policy },
    })
    switch (result.status) {
      case 'completed':
        return done(result.exitCode ?? undefined, result.stdout, result.stderr)
      case 'containment_unavailable':
        return done(
          undefined,
          '',
          `plugin hook not run: ${result.error ?? 'process sandbox unavailable'}`,
        )
      case 'timeout':
        return done(
          undefined,
          result.stdout,
          `${result.stderr}\nhook timed out after ${timeoutMs}ms`.trim(),
        )
      case 'cancelled':
        return done(
          undefined,
          result.stdout,
          `${result.stderr}\nhook cancelled`.trim(),
        )
      default:
        return done(
          undefined,
          result.stdout,
          `${result.stderr}\nhook could not start: ${result.error ?? result.status}`.trim(),
        )
    }
  }
}

/** Without the host's runner a plugin hook is not run (never unconfined). */
export const refusingPluginHookRunner: PluginHookRunner = async (
  _hook,
  options,
) => ({
  output: parseHookOutput(
    undefined,
    '',
    'plugin hook not run: no process containment is composed for plugin hooks',
    options.expectedEventName,
  ),
  durationMs: 0,
})
