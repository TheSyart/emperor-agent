/**
 * Plugin hooks in the process containment (SEC-08, SEC-07): a plugin's
 * command hook runs `/bin/sh -c <command>` through the owned process runtime
 * and the same containment as the Shell and MCP servers — the workspace
 * readable but not writable, the plugin's package readable, its data folder
 * (`plugins/data/<id>`) and temp folder (`plugins/tmp/<id>`) writable,
 * Emperor Home and the user's credentials closed, network allowed. With no
 * sandbox the hook does not run (a non-blocking hook error).
 *
 * Its environment is the safe keys (`PATH`, `HOME`, `LANG`, …) plus the
 * variables its manifest's `env` names, read from Emperor's environment,
 * plus Emperor's own (`PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`,
 * `TMPDIR`); it runs 30 seconds unless it asks for more, at most 120. Each
 * outcome goes to the plugin hook health, which the detail page reads.
 *
 * The user's own `hooks.json` hooks are trusted and keep running directly,
 * with the full environment and the 10-minute default (runner.ts).
 */

import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { SAFE_ENV_KEYS } from '../../mcp/connection'
import type { OwnedProcessRuntime } from '../../processes/runtime'
import type { ContainmentPolicy } from '../../sandbox/policy'
import { processContainmentPolicy } from '../../sandbox/presets'
import { parseHookOutput } from './codec'
import { hookVariables, type PluginHookHealth } from './plugin-health'
import type { RunHookOptions, RunHookResult } from './runner'
import type { CommandHook } from './types'

/** A plugin hook's timeout when it sets none (SEC-07). */
export const PLUGIN_HOOK_DEFAULT_TIMEOUT_MS = 30_000
/** The most a plugin hook may ask for. */
export const PLUGIN_HOOK_MAX_TIMEOUT_MS = 120_000

/** Where a plugin hook comes from: its plugin, package and data folder. */
export interface PluginHookSource {
  readonly pluginId: string
  readonly root: string | null
  readonly data: string | null
  /** Variables its manifest's `env` lets it read from Emperor's environment. */
  readonly allowedEnv?: readonly string[]
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

/** A plugin hook's timeout: what it asks for, capped at 120 s; 30 s by default. */
export function pluginHookTimeoutMs(hook: CommandHook): number {
  return hook.timeoutSec !== undefined && hook.timeoutSec > 0
    ? Math.min(hook.timeoutSec * 1000, PLUGIN_HOOK_MAX_TIMEOUT_MS)
    : PLUGIN_HOOK_DEFAULT_TIMEOUT_MS
}

/**
 * A plugin hook's environment: the safe keys and the names its manifest
 * declares, from `base`; then Emperor's own variables for it (`extra`).
 */
export function pluginHookEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  allowedEnv: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...SAFE_ENV_KEYS, ...allowedEnv]) {
    const value = base[key]
    if (value !== undefined) env[key] = value
  }
  return Object.assign(env, extra)
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

/** The last lines of a hook's stderr, for the detail page. */
function stderrLine(stderr: string): string {
  const text = stderr
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ')
  return text.length > 240 ? `…${text.slice(-239)}` : text
}

/** The host's plugin hook runner over the owned process runtime. */
export function containedPluginHookRunner(deps: {
  runtime: OwnedProcessRuntime
  stateRoot: string
  /** The home folder of the credential table; defaults to the user's. */
  home?: string
  /** Emperor's environment, which hooks take the safe and declared keys from. */
  env?: () => Readonly<Record<string, string | undefined>>
  /** Where each hook's outcome is kept for the detail page. */
  health?: PluginHookHealth
}): PluginHookRunner {
  return async (hook, options, source) => {
    const started = performance.now()
    const timeoutMs = pluginHookTimeoutMs(hook)
    const base = deps.env?.() ?? process.env
    const allowedEnv = source.allowedEnv ?? []
    const env = pluginHookEnvironment(base, allowedEnv, options.env)
    const workspace = options.cwd ?? process.cwd()
    const done = (
      exitCode: number | undefined,
      stdout: string,
      stderr: string,
      failure?: string | null,
    ) => {
      // `undefined`: not an outcome to keep (cancelled).
      if (deps.health && hook.id !== undefined && failure !== undefined)
        deps.health.record(
          source.pluginId,
          hook.id,
          failure === null
            ? null
            : {
                reason: failure,
                variables: hookVariables({
                  command: hook.command,
                  pluginRoot: source.root,
                  allowedEnv,
                  env: base,
                }),
                at: Date.now(),
              },
        )
      return {
        output: parseHookOutput(
          exitCode,
          stdout,
          stderr,
          exitCode === undefined ? undefined : options.expectedEventName,
        ),
        durationMs: Math.max(0, performance.now() - started),
      }
    }
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
      return done(
        undefined,
        '',
        `hook could not start: ${String(error)}`,
        `最近一次没能启动：${String(error)}`,
      )
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
      case 'completed': {
        const code = result.exitCode ?? undefined
        // 0 passes and 2 blocks on purpose; anything else is a failure.
        const line = stderrLine(result.stderr)
        return done(
          code,
          result.stdout,
          result.stderr,
          code === 0 || code === 2
            ? null
            : `最近一次运行失败（退出码 ${code ?? '无'}）${line ? `：${line}` : ''}`,
        )
      }
      case 'containment_unavailable':
        return done(
          undefined,
          '',
          `plugin hook not run: ${result.error ?? 'process sandbox unavailable'}`,
          `进程沙箱不可用，最近一次没有运行：${result.error ?? '原因不明'}`,
        )
      case 'timeout':
        return done(
          undefined,
          result.stdout,
          `${result.stderr}\nhook timed out after ${timeoutMs}ms`.trim(),
          `最近一次运行超过 ${Math.round(timeoutMs / 1000)} 秒，已终止`,
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
          `最近一次没能完成：${result.error ?? result.status}`,
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
