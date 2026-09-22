/**
 * CoreApi `hooks.*` facade over the harness Claude Code hook bridge.
 *
 * The only hook source is the Emperor Home `hooks.json` (Claude Code's
 * event → matcher-group format). Project `.claude/settings*.json` files are
 * deliberately not loaded: an opened repository must not be able to run
 * commands on this machine. Saving validates with the harness parser, writes
 * atomically, and reloads the live bridge.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OperationRetiredError, ValidationError } from '../../errors'
import type { ClaudeCodeHooks } from '../../harness/hooks/claude-code'
import {
  CLAUDE_HOOK_EVENTS,
  parseClaudeCodeConfig,
  type ClaudeHookEvent,
  type SkippedHook,
} from '../../harness/hooks/config'
import { matchesMatcher } from '../../harness/hooks/matcher'
import { runHook } from '../../harness/hooks/runner'
import type { SessionEvent } from '../../session-log/types'

type Dict = Record<string, unknown>

export interface CoreHooksServiceDeps {
  /** Emperor Home; the editable config is `<stateRoot>/hooks.json`. */
  stateRoot: string
  /** The live bridge; reloaded after every successful save. */
  hooks: ClaudeCodeHooks
  /** Active Build project root (substitutes `${CLAUDE_PROJECT_DIR}`, test-run cwd). */
  activeProjectRoot(): string | null
  /** Mutation gate (read-only mode etc.); throws to reject. */
  assertMutation(area: string, action: string): void
  /** Events of the active session log (for the `hook/*` audit); empty when none. */
  sessionEvents?(): readonly SessionEvent[]
}

export interface CoreHooksConfigPayload {
  /** Editable config path: `<stateRoot>/hooks.json`. */
  path: string
  /** Raw JSON text of that file (`''` when it does not exist). */
  content: string
  /** Config files the bridge loaded successfully (global + project). */
  files: string[]
  /** Runnable command hooks per event. */
  events: Record<string, number>
  /** Per-file read/parse errors from the last reload. */
  errors: string[]
  supportedEvents: ClaudeHookEvent[]
}

export interface CoreHooksValidationPayload {
  valid: boolean
  /** Runnable command hooks per event in the candidate. */
  events: Record<string, number>
  /** Non-command hooks that will be ignored. */
  skipped: SkippedHook[]
  /** Top-level keys that are not supported events (ignored). */
  unknownEvents: string[]
  errors: string[]
}

export interface CoreHooksMetadataPayload {
  format: 'claude-code'
  path: string
  events: Array<{ eventName: ClaudeHookEvent; matcher: string | null }>
  handlerTypes: ['command']
  matcher: {
    matchAll: string[]
    literal: string
    regex: string
  }
  substitutions: string[]
  defaults: { timeoutSec: number }
}

export interface CoreHookMatchItemPayload {
  /** Position in the flattened match list (use as `index` for testRun). */
  index: number
  file: string
  groupIndex: number
  hookIndex: number
  matcher: string | null
  command: string
  timeoutSec: number | null
}

export interface CoreHooksMatchPayload {
  eventName: ClaudeHookEvent
  query: string
  items: CoreHookMatchItemPayload[]
  errors: string[]
}

/** A type alias (not an interface) so it stays assignable to `Record<string, unknown>`. */
export type CoreHooksTestRunPayload = {
  eventName: ClaudeHookEvent
  command: string
  payload: Dict
  exitCode: number | null
  stdout: string
  stderr: string
  decision: string | null
  reason: string | null
  additionalContext: string | null
  durationMs: number
}

export interface CoreHookAuditRecordPayload {
  handlerId: string
  eventName: string
  turn: number
  dialect: string | null
  matcher: string | null
  outcome: string | null
  exitCode: number | null
  stderrSummary: string | null
  durationMs: number | null
  invokedAt: number | null
  completedAt: number | null
}

export interface CoreHooksAuditPayload {
  records: CoreHookAuditRecordPayload[]
  badLines: Array<{ path: string; line: number; raw: string }>
  cursor: string
  nextCursor: string | null
  total: number
}

/** Which payload field each event's matcher selects on (`null` = no matcher). */
const MATCHER_FIELD: Record<ClaudeHookEvent, string | null> = {
  SessionStart: 'source',
  UserPromptSubmit: null,
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  Stop: null,
  SubagentStart: 'agent_type',
  SubagentStop: 'agent_type',
}

const TEST_RUN_DEFAULT_TIMEOUT_MS = 10_000
const TEST_RUN_MAX_TIMEOUT_MS = 30_000

export class CoreHooksService {
  readonly stateRoot: string
  readonly configPath: string
  private readonly deps: CoreHooksServiceDeps

  constructor(deps: CoreHooksServiceDeps) {
    this.deps = deps
    this.stateRoot = deps.stateRoot
    this.configPath = join(deps.stateRoot, 'hooks.json')
  }

  async getConfig(_opts: Dict = {}): Promise<CoreHooksConfigPayload> {
    const described = this.deps.hooks.describe()
    return {
      path: this.configPath,
      content: existsSync(this.configPath)
        ? readFileSync(this.configPath, 'utf8')
        : '',
      files: described.files,
      events: described.events,
      errors: described.errors,
      supportedEvents: [...CLAUDE_HOOK_EVENTS],
    }
  }

  /**
   * Accepts raw JSON text, `{ content: string }`, or a config object. Rejects
   * anything the harness parser would drop as a whole file.
   */
  async saveConfig(raw: unknown): Promise<CoreHooksConfigPayload> {
    this.deps.assertMutation('hooks', 'saveConfig')
    const text = configText(raw)
    const validation = this.validateText(text)
    if (!validation.valid)
      throw new ValidationError(
        `hooks.json 无效：${validation.errors.join('；')}`,
      )
    await writeTextAtomic(
      this.configPath,
      text.endsWith('\n') ? text : `${text}\n`,
    )
    this.deps.hooks.reload()
    return await this.getConfig()
  }

  /** Old hook ConfigChange authorization is retired; config saves are not gated by hooks. */
  async authorizeConfigChange(_op: string, _payload: unknown): Promise<void> {}

  /** Accepts `{ content }` (raw text), `{ config }` (object), or a bare config. */
  validateConfig(input: unknown): CoreHooksValidationPayload {
    const record = isRecord(input) ? input : null
    if (record && typeof record.content === 'string')
      return this.validateText(record.content)
    if (typeof input === 'string') return this.validateText(input)
    const value = record && 'config' in record ? record.config : input
    return this.validateText(JSON.stringify(value ?? null))
  }

  getMetadata(): CoreHooksMetadataPayload {
    return {
      format: 'claude-code',
      path: this.configPath,
      events: CLAUDE_HOOK_EVENTS.map((eventName) => ({
        eventName,
        matcher: MATCHER_FIELD[eventName],
      })),
      handlerTypes: ['command'],
      matcher: {
        matchAll: ['', '*', '(omitted)'],
        literal:
          '仅含 [A-Za-z0-9_|] 的模式按 | 分隔做精确匹配，例如 "Bash|Write"',
        regex: '其他模式按非锚定正则匹配，例如 "mcp__.*"',
      },
      substitutions: ['${CLAUDE_PROJECT_DIR}', '${CLAUDE_PLUGIN_ROOT}'],
      defaults: { timeoutSec: 600 },
    }
  }

  async getAudit(
    opts: {
      cursor?: string | number | null
      limit?: number | string | null
      eventName?: string | null
      outcome?: string | null
      sourceId?: string | null
      runId?: string | null
    } = {},
  ): Promise<CoreHooksAuditPayload> {
    const all = auditRecords(this.deps.sessionEvents?.() ?? [])
      .filter((record) => {
        if (opts.eventName && record.eventName !== opts.eventName) return false
        if (opts.outcome && record.outcome !== opts.outcome) return false
        if (opts.runId && record.handlerId !== opts.runId) return false
        return true
      })
      .reverse()
    const offset = normalizeCursor(opts.cursor)
    const limit = normalizeLimit(opts.limit, 100)
    const records = all.slice(offset, offset + limit)
    const next = offset + records.length
    return {
      records,
      badLines: [],
      cursor: String(offset),
      nextCursor: next < all.length ? String(next) : null,
      total: all.length,
    }
  }

  async setProjectTrust(_input: Dict): Promise<never> {
    throw new OperationRetiredError(
      '项目 Hook 信任已下线：项目 .claude/settings.json 中的 Hook 由 Claude Code 格式直接加载，无需单独授权。',
    )
  }

  /**
   * Which loaded command hooks an event would run for `query` (tool name,
   * SessionStart source, or subagent type). `content` tests a draft instead.
   */
  async testMatch(input: Dict): Promise<CoreHooksMatchPayload> {
    const eventName = requiredEvent(input)
    const query = matchQuery(eventName, input)
    const { items, errors } = this.matchItems(eventName, query, input)
    return { eventName, query, items, errors }
  }

  /**
   * Run one command hook once with a sample payload (short timeout). Select
   * by `index` from testMatch, or pass an explicit `command`.
   */
  async testRun(input: Dict): Promise<CoreHooksTestRunPayload> {
    this.deps.assertMutation('hooks', 'testRun')
    if (input.confirmExecution !== true && input.confirm_execution !== true) {
      throw new ValidationError('需要 confirmExecution=true 才能执行 Hook 命令')
    }
    const eventName = requiredEvent(input)
    let command: string
    let timeoutSec: number | undefined
    if (typeof input.command === 'string' && input.command.trim()) {
      command = input.command
    } else {
      const { items } = this.matchItems(
        eventName,
        matchQuery(eventName, input),
        input,
      )
      const index = Number(input.index ?? 0)
      const selected = items.find((item) => item.index === index)
      if (!selected) throw new ValidationError('没有与该事件匹配的 Hook')
      command = selected.command
      timeoutSec = selected.timeoutSec ?? undefined
    }
    const projectRoot = this.deps.activeProjectRoot()
    const cwd = projectRoot ?? this.stateRoot
    const payload = samplePayload(eventName, cwd, input)
    const requested = Number(input.timeoutMs ?? input.timeout_ms ?? 0)
    const hookTimeoutMs =
      timeoutSec !== undefined ? timeoutSec * 1000 : TEST_RUN_DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.min(
      TEST_RUN_MAX_TIMEOUT_MS,
      Number.isFinite(requested) && requested > 0 ? requested : hookTimeoutMs,
    )
    const { output, durationMs } = await runHook(
      { command, timeoutSec: timeoutMs / 1000 },
      {
        payload,
        env: { CLAUDE_PROJECT_DIR: projectRoot ?? cwd },
        cwd,
        signal: new AbortController().signal,
        trailingNewline: true,
        defaultTimeoutMs: timeoutMs,
        expectedEventName: eventName,
      },
    )
    return {
      eventName,
      command,
      payload,
      exitCode: output.exitCode ?? null,
      stdout: output.stdout,
      stderr: output.stderr,
      decision: output.decision ?? (output.continue === false ? 'stop' : null),
      reason: output.reason ?? output.stopReason ?? null,
      additionalContext: output.additionalContext ?? null,
      durationMs,
    }
  }

  async cancelRun(_input: Dict): Promise<never> {
    throw new OperationRetiredError(
      '后台 Hook 运行已下线：Hook 随会话同步执行，无可取消的独立运行。',
    )
  }

  private validateText(text: string): CoreHooksValidationPayload {
    const invalid = (message: string): CoreHooksValidationPayload => ({
      valid: false,
      events: {},
      skipped: [],
      unknownEvents: [],
      errors: [message],
    })
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return invalid(`JSON 解析失败：${errorText(error)}`)
    }
    if (!isRecord(raw)) return invalid('顶层必须是 JSON 对象')
    const hooksMap = 'hooks' in raw ? raw.hooks : raw
    if (!isRecord(hooksMap))
      return invalid('"hooks" 必须是对象（事件名 → matcher 组数组）')
    const errors: string[] = []
    for (const [event, groups] of Object.entries(hooksMap)) {
      if (isSupportedEvent(event) && !Array.isArray(groups))
        errors.push(`${event} 必须是数组`)
    }
    let parsed
    try {
      parsed = parseClaudeCodeConfig(raw, this.substitutionVars())
    } catch (error) {
      return invalid(errorText(error))
    }
    const events: Record<string, number> = {}
    for (const [event, groups] of Object.entries(parsed.config)) {
      events[event] = (groups ?? []).reduce(
        (sum, group) => sum + group.hooks.length,
        0,
      )
    }
    return {
      valid: errors.length === 0,
      events,
      skipped: parsed.skipped,
      unknownEvents: Object.keys(hooksMap).filter(
        (event) => !isSupportedEvent(event),
      ),
      errors,
    }
  }

  private matchItems(
    eventName: ClaudeHookEvent,
    query: string,
    input: Dict,
  ): { items: CoreHookMatchItemPayload[]; errors: string[] } {
    const sources: Array<{ file: string; raw: unknown }> = []
    const errors: string[] = []
    if (typeof input.content === 'string') {
      try {
        sources.push({ file: this.configPath, raw: JSON.parse(input.content) })
      } catch (error) {
        errors.push(`${this.configPath}: ${errorText(error)}`)
      }
    } else {
      for (const file of this.deps.hooks.describe().files) {
        try {
          sources.push({ file, raw: JSON.parse(readFileSync(file, 'utf8')) })
        } catch (error) {
          errors.push(`${file}: ${errorText(error)}`)
        }
      }
    }
    const items: CoreHookMatchItemPayload[] = []
    for (const { file, raw } of sources) {
      let groups
      try {
        groups =
          parseClaudeCodeConfig(raw, this.substitutionVars()).config[
            eventName
          ] ?? []
      } catch (error) {
        errors.push(`${file}: ${errorText(error)}`)
        continue
      }
      groups.forEach((group, groupIndex) => {
        if (!matchesMatcher(group.matcher, query, 'claude-code')) return
        group.hooks.forEach((hook, hookIndex) => {
          items.push({
            index: items.length,
            file,
            groupIndex,
            hookIndex,
            matcher: group.matcher ?? null,
            command: hook.command,
            timeoutSec: hook.timeoutSec ?? null,
          })
        })
      })
    }
    return { items, errors }
  }

  private substitutionVars(): { projectDir?: string } {
    const projectDir = this.deps.activeProjectRoot()
    return projectDir ? { projectDir } : {}
  }
}

function auditRecords(
  events: readonly SessionEvent[],
): CoreHookAuditRecordPayload[] {
  const byHandler = new Map<string, CoreHookAuditRecordPayload>()
  const ordered: CoreHookAuditRecordPayload[] = []
  for (const event of events) {
    if (event.type === 'hook/invoked') {
      const record: CoreHookAuditRecordPayload = {
        handlerId: event.data.handlerId,
        eventName: event.data.point,
        turn: event.data.turn,
        dialect: event.data.dialect,
        matcher: event.data.matcher ?? null,
        outcome: null,
        exitCode: null,
        stderrSummary: null,
        durationMs: null,
        invokedAt: event.time,
        completedAt: null,
      }
      byHandler.set(record.handlerId, record)
      ordered.push(record)
    } else if (event.type === 'hook/result') {
      let record = byHandler.get(event.data.handlerId)
      if (!record) {
        record = {
          handlerId: event.data.handlerId,
          eventName: event.data.point,
          turn: event.data.turn,
          dialect: null,
          matcher: null,
          outcome: null,
          exitCode: null,
          stderrSummary: null,
          durationMs: null,
          invokedAt: null,
          completedAt: null,
        }
        byHandler.set(record.handlerId, record)
        ordered.push(record)
      }
      record.outcome = event.data.decision
      record.exitCode = event.data.exitCode ?? null
      record.stderrSummary = event.data.stderrSummary ?? null
      record.durationMs = event.data.durationMs
      record.completedAt = event.time
    }
  }
  return ordered
}

function samplePayload(
  eventName: ClaudeHookEvent,
  cwd: string,
  input: Dict,
): Dict {
  const base: Dict = {
    session_id: 'hook-test',
    transcript_path: '',
    cwd,
    hook_event_name: eventName,
  }
  const toolName = stringField(input, 'toolName', 'tool_name') || 'Bash'
  const toolInput = isRecord(input.toolInput)
    ? input.toolInput
    : isRecord(input.tool_input)
      ? input.tool_input
      : { command: 'echo hello' }
  const sample: Record<ClaudeHookEvent, Dict> = {
    SessionStart: { source: stringField(input, 'source') || 'startup' },
    UserPromptSubmit: {
      prompt: stringField(input, 'prompt') || 'Hook 测试提示',
    },
    PreToolUse: {
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'hook-test-call',
    },
    PostToolUse: {
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'hook-test-call',
      tool_response: isRecord(input.toolResponse)
        ? input.toolResponse
        : { output: 'hello' },
    },
    Stop: { stop_hook_active: false },
    SubagentStart: {
      agent_id: 'hook-test-agent',
      agent_type:
        stringField(input, 'agentType', 'agent_type') || 'general-purpose',
    },
    SubagentStop: {
      agent_id: 'hook-test-agent',
      agent_type:
        stringField(input, 'agentType', 'agent_type') || 'general-purpose',
      stop_hook_active: false,
    },
  }
  return {
    ...base,
    ...sample[eventName],
    ...(isRecord(input.payload) ? input.payload : {}),
  }
}

function matchQuery(eventName: ClaudeHookEvent, input: Dict): string {
  const explicit = stringField(input, 'query')
  if (explicit) return explicit
  switch (MATCHER_FIELD[eventName]) {
    case 'tool_name':
      return stringField(input, 'toolName', 'tool_name')
    case 'source':
      return stringField(input, 'source') || 'startup'
    case 'agent_type':
      return stringField(input, 'agentType', 'agent_type') || 'general-purpose'
    default:
      return ''
  }
}

function requiredEvent(input: Dict): ClaudeHookEvent {
  const eventName = stringField(input, 'eventName', 'event_name')
  if (!isSupportedEvent(eventName))
    throw new ValidationError(`不支持的 Hook 事件：${eventName || '(空)'}`)
  return eventName
}

function isSupportedEvent(value: string): value is ClaudeHookEvent {
  return (CLAUDE_HOOK_EVENTS as readonly string[]).includes(value)
}

function configText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (isRecord(raw) && typeof raw.content === 'string') return raw.content
  const value = isRecord(raw) && 'config' in raw ? raw.config : raw
  return JSON.stringify(value ?? null, null, 2)
}

async function writeTextAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tmp, 'wx', 0o644)
    await handle.writeFile(body, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tmp, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw error
  }
}

function stringField(input: Dict, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10)
  return Number.isFinite(parsed) ? Math.min(500, Math.max(1, parsed)) : fallback
}

function normalizeCursor(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
