/**
 * What a plugin's hooks last did, for the plugin's detail page (SEC-07). A
 * plugin hook starts from a narrow environment (the safe keys plus what its
 * manifest's `env` names), so a hook written for a full environment may
 * fail: the latest failure of each hook (by plugin and hook member id) is
 * kept with a reason in the user's words and the variables the hook may
 * need. A run that works clears it. Nothing is persisted: a restart starts
 * clean.
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { SAFE_ENV_KEYS } from '../../mcp/connection'
import { canonicalizeExistingPath, isPathWithin } from '../../util/paths'

/** A variable a failed plugin hook may need. */
export interface PluginHookVariable {
  readonly name: string
  /**
   * `undeclared`: the hook reads it, but the manifest's `env` does not list
   * it; `unset`: listed, but Emperor's environment has no value for it.
   */
  readonly state: 'undeclared' | 'unset'
}

export interface PluginHookFailure {
  readonly reason: string
  readonly variables: readonly PluginHookVariable[]
  /** When it failed (ms since the epoch). */
  readonly at: number
}

export class PluginHookHealth {
  private readonly failures = new Map<string, PluginHookFailure>()
  private readonly listeners = new Set<() => void>()

  failure(pluginId: string, hookId: string): PluginHookFailure | null {
    return this.failures.get(`${pluginId}\0${hookId}`) ?? null
  }

  /**
   * A hook's outcome: its failure, or `null` once it works. Listeners hear
   * when a hook starts or stops failing, or fails for another reason.
   */
  record(
    pluginId: string,
    hookId: string,
    failure: PluginHookFailure | null,
  ): void {
    const key = `${pluginId}\0${hookId}`
    const before = this.failures.get(key)
    if (failure === null) {
      if (!before) return
      this.failures.delete(key)
    } else {
      this.failures.set(key, failure)
      if (
        before?.reason === failure.reason &&
        JSON.stringify(before.variables) === JSON.stringify(failure.variables)
      )
        return
    }
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener never breaks the hook run.
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/** Given to every plugin hook besides the safe keys. */
const PROVIDED = new Set([
  'PLUGIN_ROOT',
  'PLUGIN_DATA',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PROJECT_DIR',
])

/** The shell's own variables, which no one provides from outside. */
const SHELL_OWN = new Set([
  'PWD',
  'OLDPWD',
  'IFS',
  'RANDOM',
  'LINENO',
  'SECONDS',
  'PPID',
  'UID',
  'EUID',
  'HOSTNAME',
  'SHLVL',
  'OPTARG',
  'OPTIND',
  'REPLY',
  'BASH_SOURCE',
  'BASH_REMATCH',
  'PIPESTATUS',
  'FUNCNAME',
  'COLUMNS',
  'LINES',
])

/** `$NAME` / `${NAME}`: environment variables are upper case by convention. */
const SHELL_REF = /\$\{?([A-Z_][A-Z0-9_]*)/g
/** Node, Python, Ruby and C ways of reading one variable by name. */
const ACCESSOR_REF =
  /(?:process\.env(?:\.|\[\s*['"])|os\.environ(?:\.get)?\s*[[(]\s*['"]|(?:os\.)?getenv\s*\(\s*['"]|ENV(?:\.fetch)?\s*[[(]\s*['"])([A-Za-z_][A-Za-z0-9_]*)/g
/** A script's own variables (`NAME=`, `export NAME=`, `local NAME=`). */
const ASSIGNED =
  /^\s*(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=/gm
const MAX_SCRIPT_BYTES = 64 * 1024
const MAX_VARIABLES = 8

/**
 * The variables a plugin hook may need that it did not get: the ones its
 * manifest declares that Emperor's environment lacks, then the ones its
 * command (and up to two scripts of its own package the command names)
 * reads without declaring them. Best effort, from the text only.
 */
export function hookVariables(input: {
  readonly command: string
  readonly pluginRoot: string | null
  readonly allowedEnv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
}): PluginHookVariable[] {
  const allowed = new Set(input.allowedEnv)
  const assigned = new Set<string>()
  const referenced = new Set<string>()
  for (const text of [
    input.command,
    ...packageScripts(input.command, input.pluginRoot),
  ]) {
    for (const match of text.matchAll(ASSIGNED)) assigned.add(match[1]!)
    for (const pattern of [SHELL_REF, ACCESSOR_REF])
      for (const match of text.matchAll(pattern)) referenced.add(match[1]!)
  }
  const variables: PluginHookVariable[] = input.allowedEnv
    .filter((name) => input.env[name] === undefined)
    .map((name) => ({ name, state: 'unset' }))
  for (const name of referenced)
    if (
      !allowed.has(name) &&
      !assigned.has(name) &&
      !SAFE_ENV_KEYS.has(name) &&
      !PROVIDED.has(name) &&
      !SHELL_OWN.has(name)
    )
      variables.push({ name, state: 'undeclared' })
  return variables.slice(0, MAX_VARIABLES)
}

/** Text of the files in the plugin's own package that `command` names. */
function packageScripts(command: string, root: string | null): string[] {
  if (!root) return []
  const realRoot = canonicalizeExistingPath(root)
  const texts: string[] = []
  const expanded = command.replace(/\$\{?(?:CLAUDE_)?PLUGIN_ROOT\}?/g, root)
  for (const word of expanded.split(/\s+/)) {
    const path = word.replace(/^['"(]+|['";|&)]+$/g, '')
    if (!isAbsolute(path) || !isPathWithin(path, root)) continue
    try {
      const real = canonicalizeExistingPath(path)
      const info = statSync(real)
      if (
        !isPathWithin(real, realRoot) ||
        !info.isFile() ||
        info.size > MAX_SCRIPT_BYTES
      )
        continue
      texts.push(readFileSync(real, 'utf8'))
    } catch {
      continue
    }
    if (texts.length === 2) break
  }
  return texts
}
