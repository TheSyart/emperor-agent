/**
 * Parse Claude Code's event → matcher-group hook format (ported from
 * dsh-hooks-claude-code config.ts). Accepts a settings object with a `hooks`
 * key or a bare `hooks.json` event map. Only command hooks run; other hook
 * types are returned as skipped so the bridge can warn. `${CLAUDE_PLUGIN_ROOT}`
 * / `${CLAUDE_PROJECT_DIR}` are substituted at parse time.
 */

import { join } from 'node:path'
import { matcherDiagnostic } from './matcher'
import type { MatcherGroup } from './types'

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number]

/** Event name → its matcher groups (command hooks only). */
export type ClaudeCodeHookConfig = Partial<
  Record<ClaudeHookEvent, MatcherGroup[]>
>

export interface SkippedHook {
  event: string
  type: string
}

export interface ParsedClaudeConfig {
  config: ClaudeCodeHookConfig
  skipped: SkippedHook[]
}

export interface SubstitutionVars {
  /** Replaces `${CLAUDE_PLUGIN_ROOT}`. */
  pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}`. */
  projectDir?: string
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Apply the substitutions; a token whose variable is unset stays verbatim (the env var still resolves it). */
export function substituteCommand(
  command: string,
  vars: SubstitutionVars,
): string {
  let out = command
  if (vars.pluginRoot !== undefined)
    out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined)
    out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

/**
 * Parse one config value. Malformed entries and unsupported events are
 * ignored; matchers on UserPromptSubmit/Stop are discarded (no subject). An
 * invalid regex on a runnable matcher-bearing group throws `SyntaxError`, so
 * the caller can reject the whole file.
 */
export function parseClaudeCodeConfig(
  raw: unknown,
  vars: SubstitutionVars = {},
): ParsedClaudeConfig {
  const config: ClaudeCodeHookConfig = {}
  const skipped: SkippedHook[] = []
  const root = asObject(raw)
  const hooksMap = root
    ? (asObject(root.hooks) ?? ('hooks' in root ? undefined : root))
    : undefined
  if (!hooksMap) return { config, skipped }

  for (const event of CLAUDE_HOOK_EVENTS) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups: MatcherGroup[] = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const commands: MatcherGroup['hooks'] = []
      for (const rawHook of group.hooks) {
        const hook = asObject(rawHook)
        if (!hook) continue
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        if (type !== 'command') {
          skipped.push({ event, type })
          continue
        }
        if (typeof hook.command !== 'string') continue
        commands.push({
          command: substituteCommand(hook.command, vars),
          ...(typeof hook.timeout === 'number' &&
          Number.isFinite(hook.timeout) &&
          hook.timeout > 0
            ? { timeoutSec: hook.timeout }
            : {}),
        })
      }
      if (commands.length === 0) continue
      const matcher =
        event === 'UserPromptSubmit' || event === 'Stop'
          ? undefined
          : typeof group.matcher === 'string'
            ? group.matcher
            : undefined
      const diagnostic = matcherDiagnostic(matcher, 'claude-code')
      if (diagnostic !== undefined)
        throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`)
      groups.push({
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: commands,
      })
    }
    if (groups.length > 0) config[event] = groups
  }
  return { config, skipped }
}

/**
 * Default config discovery, in concatenation order: the Emperor Home
 * `hooks.json`, then the project's `.claude/settings.json` and
 * `.claude/settings.local.json`. Missing files are skipped by the loader.
 */
export function defaultHookConfigPaths(options: {
  stateRoot: string
  projectDir?: string
}): string[] {
  const paths = [join(options.stateRoot, 'hooks.json')]
  if (options.projectDir !== undefined) {
    paths.push(
      join(options.projectDir, '.claude', 'settings.json'),
      join(options.projectDir, '.claude', 'settings.local.json'),
    )
  }
  return paths
}
