/**
 * Plugin hook files (plugin contract §4).
 *
 * - Emperor dialect (`emperor-v1` packages) keeps Claude Code's shape and
 *   Emperor tool names; nothing is translated.
 * - Codex dialect (portable and codex-compat packages) uses Codex events,
 *   case-sensitive regex matchers and Codex tool names. An entry runs only
 *   when its event, matcher and handler all fit the fixed tables below;
 *   everything else stays an unsupported member. Nothing is half-translated.
 */

import {
  CLAUDE_HOOK_EVENTS,
  type ClaudeHookEvent,
} from '../harness/hooks/config'
import { matcherDiagnostic } from '../harness/hooks/matcher'
import { PluginPackageError } from './errors'
import type { PluginHookSpec, ResolvedPluginComponent } from './models'

export type PluginHookDialect = PluginHookSpec['dialect']

export interface PluginHookSource {
  /** A hook file's JSON, or an inline hooks object from a manifest. */
  readonly raw: unknown
  /** Package-relative label used in messages. */
  readonly label: string
  /** Absolute path of the declaring file (Core-internal). */
  readonly sourcePath: string
}

export interface PluginHookContext {
  readonly dialect: PluginHookDialect
  /** This package's MCP server names, for `mcp__<server>__<tool>` tokens. */
  readonly mcpServers: readonly string[]
  /** Running handler count per event, shared across the package's hook sources. */
  readonly counts: Map<string, number>
}

export interface ParsedPluginHooks {
  readonly hooks: PluginHookSpec[]
  readonly components: ResolvedPluginComponent[]
}

type Mapped = NonNullable<PluginHookSpec['mapped']>

/** Codex events Emperor runs, with how their matcher is read. */
const CODEX_EVENTS = new Map<
  string,
  'tools' | 'sources' | 'ignored' | 'all-only'
>([
  ['SessionStart', 'sources'],
  ['UserPromptSubmit', 'ignored'],
  ['PreToolUse', 'tools'],
  ['PostToolUse', 'tools'],
  ['Stop', 'ignored'],
  ['SubagentStart', 'all-only'],
  ['SubagentStop', 'all-only'],
])

const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact'])

/** Codex (and Claude Code) tool tokens → Emperor tools. `apply_patch`, `Edit` and `Write` are one tool in Codex. */
export const CODEX_TOOL_NAMES = new Map<string, readonly string[]>([
  ['Bash', ['bash']],
  ['apply_patch', ['edit', 'write']],
  ['Edit', ['edit', 'write']],
  ['Write', ['edit', 'write']],
  ['MultiEdit', ['edit']],
  ['Read', ['read']],
  ['Glob', ['glob']],
  ['Grep', ['grep']],
  ['WebSearch', ['web_search']],
  ['web_search', ['web_search']],
  ['WebFetch', ['web_fetch']],
  ['web_fetch', ['web_fetch']],
  ['update_plan', ['todo_write']],
  ['TodoWrite', ['todo_write']],
  ['Agent', ['subagent', 'subagent_fork']],
  ['spawn_agent', ['subagent', 'subagent_fork']],
  ['Task', ['subagent', 'subagent_fork']],
])

const EMPEROR_EVENTS = new Set<string>(CLAUDE_HOOK_EVENTS)
const NO_MATCHER_EVENTS = new Set(['UserPromptSubmit', 'Stop'])

/** Parse one hook source; throws `member_invalid` for a file that is not a hooks document. */
export function parsePluginHooks(
  source: PluginHookSource,
  context: PluginHookContext,
): ParsedPluginHooks {
  const hooks: PluginHookSpec[] = []
  const components: ResolvedPluginComponent[] = []
  const root = objectOf(source.raw)
  if (!root) throw invalid(`${source.label} 必须是 JSON 对象`)
  let events: Record<string, unknown>
  if ('hooks' in root) {
    const inner = objectOf(root.hooks)
    if (!inner) throw invalid(`${source.label} 的 hooks 必须是对象`)
    events = inner
  } else events = root
  for (const [event, rawGroups] of Object.entries(events)) {
    if (!Array.isArray(rawGroups))
      throw invalid(`${source.label} 里 ${event} 的值必须是数组`)
    for (const rawGroup of rawGroups) {
      const group = objectOf(rawGroup)
      if (!group || !Array.isArray(group.hooks))
        throw invalid(`${source.label} 里 ${event} 的每一项都要有 hooks 数组`)
      const matcher = group.matcher
      if (matcher !== undefined && typeof matcher !== 'string')
        throw invalid(`${source.label} 里 ${event} 的 matcher 必须是字符串`)
      for (const rawHandler of group.hooks) {
        const handler = objectOf(rawHandler)
        if (!handler)
          throw invalid(`${source.label} 里 ${event} 的处理项必须是对象`)
        const { unsupported, ...spec } = parseHandler(
          event,
          matcher ?? null,
          handler,
          source,
          context,
        )
        hooks.push(spec)
        components.push(hookComponent(spec, unsupported, source.sourcePath))
      }
    }
  }
  return { hooks, components }
}

function parseHandler(
  event: string,
  matcher: string | null,
  handler: Record<string, unknown>,
  source: PluginHookSource,
  context: PluginHookContext,
): PluginHookSpec & { unsupported?: string } {
  const type = handler.type ?? 'command'
  if (typeof type !== 'string')
    throw invalid(`${source.label} 里 ${event} 的 type 必须是字符串`)
  const command = handler.command
  if (type === 'command' && (typeof command !== 'string' || !command.trim()))
    throw invalid(`${source.label} 里 ${event} 的 command 必须是非空字符串`)
  const timeout = handler.timeout
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
  )
    throw invalid(`${source.label} 里 ${event} 的 timeout 必须是正数（秒）`)
  const count = (context.counts.get(event) ?? 0) + 1
  context.counts.set(event, count)
  const base = {
    id: `${event}#${count}`,
    dialect: context.dialect,
    event,
    matcher: NO_MATCHER_EVENTS.has(event) ? null : matcher,
    command: typeof command === 'string' ? command : '',
    ...(typeof timeout === 'number' ? { timeoutSec: timeout } : {}),
  }
  const verdict =
    context.dialect === 'emperor'
      ? emperorVerdict(event, matcher, type, source)
      : codexVerdict(event, matcher, type, handler, context)
  return 'mapped' in verdict
    ? { ...base, mapped: verdict.mapped }
    : { ...base, unsupported: verdict.reason }
}

function emperorVerdict(
  event: string,
  matcher: string | null,
  type: string,
  source: PluginHookSource,
): { mapped: Mapped } | { reason: string } {
  if (!EMPEROR_EVENTS.has(event))
    return { reason: `Emperor 没有 ${event} 这个 Hook 事件` }
  if (type !== 'command')
    return { reason: `Emperor 只运行 command 类型的 Hook，不支持 ${type}` }
  if (NO_MATCHER_EVENTS.has(event))
    return { mapped: { event: event as ClaudeHookEvent } }
  const diagnostic = matcherDiagnostic(matcher ?? undefined, 'claude-code')
  if (diagnostic !== undefined)
    throw invalid(
      `${source.label} 里 ${event} 的 matcher 不是合法的正则：${matcher}`,
    )
  return {
    mapped: {
      event: event as ClaudeHookEvent,
      ...(matcher !== null ? { matcher } : {}),
    },
  }
}

function codexVerdict(
  event: string,
  matcher: string | null,
  type: string,
  handler: Record<string, unknown>,
  context: PluginHookContext,
): { mapped: Mapped } | { reason: string } {
  const reading = CODEX_EVENTS.get(event)
  if (reading === undefined)
    return { reason: `Emperor 不支持 ${event} 这个 Hook 事件` }
  if (type === 'mcp_tool')
    return { reason: 'Emperor 不支持 mcp_tool 类型的 Hook' }
  if (type !== 'command')
    return { reason: `Emperor 只运行 command 类型的 Hook，不支持 ${type}` }
  if (handler.async === true)
    return { reason: 'Emperor 不支持在后台运行的 Hook（async）' }
  const mappedEvent = event as ClaudeHookEvent
  if (reading === 'ignored' || matchesAll(matcher))
    return { mapped: { event: mappedEvent } }
  if (reading === 'all-only')
    return { reason: `${event} 的匹配条件在 Emperor 里没有对应` }
  const tokens = literalTokens(matcher!)
  if (tokens === null)
    return {
      reason: `匹配条件「${matcher}」不是名字的简单并列，Emperor 不翻译一般正则`,
    }
  if (reading === 'sources') {
    const unknown = tokens.find((token) => !SESSION_SOURCES.has(token))
    return unknown === undefined
      ? { mapped: { event: mappedEvent, subjects: tokens } }
      : { reason: `SessionStart 的来源「${unknown}」在 Emperor 里没有对应` }
  }
  const subjects: string[] = []
  const mcpTools: Array<{ server: string; tool: string }> = []
  for (const token of tokens) {
    const names = CODEX_TOOL_NAMES.get(token)
    if (names) {
      for (const name of names)
        if (!subjects.includes(name)) subjects.push(name)
      continue
    }
    const mcp = mcpToken(token, context.mcpServers)
    if (mcp === 'foreign')
      return { reason: `「${token}」不是本插件的 MCP 工具，Emperor 无法对应` }
    if (mcp === null) return { reason: `Emperor 没有与「${token}」对应的工具` }
    mcpTools.push(mcp)
  }
  return {
    mapped: {
      event: mappedEvent,
      subjects,
      ...(mcpTools.length ? { mcpTools } : {}),
    },
  }
}

/** `mcp__<server>__<tool>` for one of this package's servers; the longest matching server name wins. */
function mcpToken(
  token: string,
  servers: readonly string[],
): { server: string; tool: string } | 'foreign' | null {
  if (!token.startsWith('mcp__')) return null
  const server = [...servers]
    .sort((left, right) => right.length - left.length)
    .find(
      (name) =>
        token.startsWith(`mcp__${name}__`) &&
        token.length > `mcp__${name}__`.length,
    )
  if (server === undefined) return 'foreign'
  return { server, tool: token.slice(`mcp__${server}__`.length) }
}

/** The names of `A|B`, `^A$` or `^(A|B)$`; `null` for anything else. */
function literalTokens(matcher: string): string[] | null {
  const match = /^\^?(?:\(([^()]*)\)|([^()]*?))\$?$/.exec(matcher)
  if (!match) return null
  const body = match[1] ?? match[2] ?? ''
  const tokens = body.split('|')
  if (!tokens.every((token) => /^[A-Za-z0-9_-]+$/.test(token))) return null
  return [...new Set(tokens)]
}

function matchesAll(matcher: string | null): boolean {
  return matcher === null || matcher === '' || matcher === '*'
}

function hookComponent(
  spec: PluginHookSpec,
  unsupported: string | undefined,
  sourcePath: string,
): ResolvedPluginComponent {
  const subject = matchesAll(spec.matcher) ? '全部' : spec.matcher
  return {
    kind: 'hook',
    id: spec.id,
    title: NO_MATCHER_EVENTS.has(spec.event)
      ? spec.event
      : `${spec.event} · ${subject}`,
    description: spec.command,
    sourcePath,
    state: unsupported === undefined ? 'available' : 'unsupported',
    reason: unsupported ?? null,
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function invalid(message: string): PluginPackageError {
  return new PluginPackageError('member_invalid', message)
}
