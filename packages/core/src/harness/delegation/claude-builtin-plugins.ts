/**
 * Claude Code's own plugins (VER-02).
 *
 * Since 2.1.308 the claude binary ships a plugin of its own,
 * `cc-plugin-plugin-authoring@builtin`, and the run's init gate refused
 * every Claude subtask for it. Emperor turns every builtin plugin off: the
 * known ones from launch (`settings.enabledPlugins`), and one a newer
 * claude reports before the first prompt in the running process
 * (adapters/claude.ts, preflightClaudePlugins; measured on the real
 * binaries in VER-01). What it learns is kept in
 * `<delegations>/claude-code/builtin-plugins.json`, outside the folders a
 * Claude process may write, so the next run starts with it off.
 *
 * Only ever off: the ledger names plugins to turn off, never one to turn
 * on, and it never holds a plugin that is not builtin. A plugin from disk
 * or a marketplace, and any MCP server, stay refused.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableReplaceSync } from '../../store/persistence'
import { logger } from '../../util/log'
import { describeUnapprovedExtensions } from './failure'
import { DelegationError } from './types'

const log = logger.child({ component: 'executors' })

/** Builtins known when this build was made, all turned off. */
export const SEED_BUILTIN_PLUGINS = [
  'agents-md@builtin',
  'telemetry@builtin',
  // Since 2.1.308 (VER-01).
  'cc-plugin-plugin-authoring@builtin',
] as const

/** A plugin as reloadPlugins() or system/init reports it. */
export interface ReportedPlugin {
  name: string
  path: string
  source?: string
  version?: string
}

/** Only what the claude binary ships: path `builtin`, source `<name>@builtin`. */
export function isBuiltinPlugin(p: ReportedPlugin): boolean {
  return p.path === 'builtin' && p.source === `${p.name}@builtin`
}

export const BUILTIN_PLUGIN_LEDGER_FILE = 'builtin-plugins.json'

/** `<delegations>/claude-code/builtin-plugins.json` */
export interface BuiltinPluginLedgerFile {
  schemaVersion: 1
  plugins: Record<
    string /* source */,
    {
      name: string
      firstSeenVersion: string
      lastSeenVersion: string
      /** epoch ms */
      learnedAt: number
    }
  >
}

type Entry = BuiltinPluginLedgerFile['plugins'][string]

function valid(value: unknown): value is BuiltinPluginLedgerFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Record<string, unknown>
  if (file.schemaVersion !== 1) return false
  const plugins = file.plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins))
    return false
  return Object.entries(plugins).every(([source, entry]) => {
    const e = entry as Partial<Entry> | null
    return (
      !!e &&
      typeof e === 'object' &&
      typeof e.name === 'string' &&
      source === `${e.name}@builtin` &&
      typeof e.firstSeenVersion === 'string' &&
      typeof e.lastSeenVersion === 'string' &&
      typeof e.learnedAt === 'number'
    )
  })
}

/**
 * The builtins Emperor turns off. Without a folder (tests, tools) it keeps
 * what it learns in memory. A damaged file is left as it is: the seed
 * still applies, what this process learns is used but never written.
 */
export class BuiltinPluginLedger {
  readonly file: string | undefined
  private plugins: BuiltinPluginLedgerFile['plugins'] = {}
  private damagedFile = false
  private readonly now: () => number
  constructor(root?: string, options: { now?: () => number } = {}) {
    this.file = root ? join(root, BUILTIN_PLUGIN_LEDGER_FILE) : undefined
    this.now = options.now ?? Date.now
    this.plugins = this.read()
  }
  /** The file could not be read: only the seed and this process's own. */
  get damaged(): boolean {
    return this.damagedFile
  }
  private read(): BuiltinPluginLedgerFile['plugins'] {
    if (!this.file || this.damagedFile || !existsSync(this.file))
      return { ...this.plugins }
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!valid(data)) throw new Error('unsupported builtin plugin ledger')
      return { ...data.plugins }
    } catch (error) {
      this.damagedFile = true
      log.warn('builtin plugin ledger unreadable; using the seed only', {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      })
      return { ...this.plugins }
    }
  }
  /** The seed and every builtin learned, sorted. */
  disabled(): string[] {
    return [
      ...new Set([...SEED_BUILTIN_PLUGINS, ...Object.keys(this.plugins)]),
    ].sort()
  }
  /**
   * Remembers the builtins among `plugins` (anything else is ignored) and
   * returns the ones it had not known. Merged with the file as it is now,
   * so two runs learning at once both keep theirs.
   */
  learn(plugins: readonly ReportedPlugin[], claudeVersion: string): string[] {
    const builtins = plugins.filter(isBuiltinPlugin)
    if (!builtins.length) return []
    const current = this.read()
    const learned: string[] = []
    let changed = false
    for (const plugin of builtins) {
      const source = plugin.source!
      const known = current[source]
      if (known) {
        if (known.lastSeenVersion !== claudeVersion) {
          current[source] = { ...known, lastSeenVersion: claudeVersion }
          changed = true
        }
        continue
      }
      current[source] = {
        name: plugin.name,
        firstSeenVersion: claudeVersion,
        lastSeenVersion: claudeVersion,
        learnedAt: this.now(),
      }
      changed = true
      if (!(SEED_BUILTIN_PLUGINS as readonly string[]).includes(source))
        learned.push(source)
    }
    this.plugins = current
    if (changed && this.file && !this.damagedFile)
      try {
        durableReplaceSync(
          this.file,
          JSON.stringify(
            {
              schemaVersion: 1,
              plugins: current,
            } satisfies BuiltinPluginLedgerFile,
            null,
            2,
          ) + '\n',
        )
      } catch (error) {
        // Still off in this process; the next run turns it off again.
        log.warn('builtin plugin ledger not saved', {
          file: this.file,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    return learned
  }
  /** `settings.enabledPlugins` for a launch: every value false. */
  enabledPluginsSetting(): Record<string, false> {
    return Object.fromEntries(this.disabled().map((s) => [s, false] as const))
  }
}

/** The part of the SDK's Query the preflight uses. */
export interface ClaudePluginControl {
  reloadPlugins(): Promise<{
    plugins?: readonly ReportedPlugin[]
    mcpServers?: readonly { name: string }[]
    error_count?: number
  }>
  applyFlagSettings(settings: {
    enabledPlugins: Record<string, false>
  }): Promise<void>
}

export type ClaudePluginPreflight =
  /** The CLI did not answer reloadPlugins in time: the init gate decides. */
  | { status: 'unsupported' }
  /** Nothing loaded besides what Emperor allows. */
  | { status: 'clean' }
  /** Builtins it reported were turned off in the running process. */
  | { status: 'adapted'; disabled: string[]; learned: string[] }

/** How long each control request may take (VER-01: 8–18 ms each). */
export const PLUGIN_PREFLIGHT_TIMEOUT_MS = 5_000

function within<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.resolve().then(run),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

function refused(reason: string): DelegationError {
  return new DelegationError('EXECUTOR_INCOMPATIBLE', reason, reason)
}

/**
 * Before the first prompt (VER-02): asks the running claude which plugins
 * and MCP servers it loaded. Builtins Emperor did not know are turned off
 * in the same process (`applyFlagSettings`, then checked again) and
 * learned; a plugin that is not builtin, an MCP server or a plugin error
 * refuses the run, learning nothing. A claude that cannot answer leaves it
 * to the init gate. No prompt is sent, so no model is called.
 */
export async function preflightClaudePlugins(
  query: Partial<ClaudePluginControl>,
  ledger: BuiltinPluginLedger,
  claudeVersion: string | undefined,
  timeoutMs = PLUGIN_PREFLIGHT_TIMEOUT_MS,
): Promise<ClaudePluginPreflight> {
  let reported: Awaited<ReturnType<ClaudePluginControl['reloadPlugins']>>
  try {
    reported = await within(() => query.reloadPlugins!(), timeoutMs)
  } catch {
    return { status: 'unsupported' }
  }
  const check = (
    answer: typeof reported,
  ): { plugins: ReportedPlugin[]; servers: string[] } => {
    const servers = (answer.mcpServers ?? []).map((s) => String(s.name))
    if (servers.length)
      throw refused(describeUnapprovedExtensions({ kind: 'mcp', servers }))
    if ((answer.error_count ?? 0) > 0)
      throw refused(
        describeUnapprovedExtensions({
          kind: 'errors',
          claudeVersion,
          errorCount: answer.error_count!,
        }),
      )
    return { plugins: [...(answer.plugins ?? [])], servers }
  }
  const { plugins } = check(reported)
  if (!plugins.length) return { status: 'clean' }
  const foreign = plugins.filter((p) => !isBuiltinPlugin(p))
  if (foreign.length)
    throw refused(
      describeUnapprovedExtensions({
        kind: 'foreign',
        claudeVersion,
        plugins: foreign,
      }),
    )
  const disabled = plugins.map((p) => p.source!)
  const stuck = (still: readonly string[]) =>
    refused(
      describeUnapprovedExtensions({
        kind: 'stuck',
        claudeVersion,
        plugins: still,
      }),
    )
  let after: ReportedPlugin[]
  try {
    await within(
      () =>
        query.applyFlagSettings!({
          enabledPlugins: {
            ...ledger.enabledPluginsSetting(),
            ...Object.fromEntries(disabled.map((s) => [s, false] as const)),
          },
        }),
      timeoutMs,
    )
    after = check(await within(() => query.reloadPlugins!(), timeoutMs)).plugins
  } catch (error) {
    if (error instanceof DelegationError) throw error
    throw stuck(disabled)
  }
  if (after.length) throw stuck(after.map((p) => p.source ?? p.name))
  return {
    status: 'adapted',
    disabled,
    learned: ledger.learn(plugins, claudeVersion ?? 'unknown'),
  }
}
