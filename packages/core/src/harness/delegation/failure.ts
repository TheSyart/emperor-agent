/**
 * Why an external run failed outside its executor's own report (FIX-15):
 * preparing its workspace, its runtime, opening or talking to the process.
 * Such a failure used to settle as a bare EXECUTOR_ERROR with an empty
 * summary and nothing in any log. Now it has a failure code the UI and the
 * parent can act on, one Chinese line for the run's summary (the subagent
 * row, 任务详情 and the parent's notice show it), and a sanitised message
 * for core.log. Neither ever carries a key, the environment or the prompt.
 */
import { homedir } from 'node:os'
import { WorkspaceOperationError } from '../../workspace/common'
import { redactLogText } from '../../util/redaction'
import { redactExecutorText } from './redaction'
import type { ExternalBackend } from './types'

/** Where in a run the failure happened, in the order a run goes through. */
export type RunStage =
  | 'budget'
  | 'self-check'
  | 'workspace'
  | 'lock'
  | 'runtime'
  | 'preflight'
  | 'open'
  | 'submit'
  | 'events'

/** Failure codes of a run whose workspace could not be prepared. */
export const WORKSPACE_FAILURE_CODES = [
  'WORKSPACE_GIT_UNAVAILABLE',
  'WORKSPACE_GIT_FAILED',
  'WORKSPACE_PREPARE_FAILED',
] as const

export interface RunFailure {
  /** The run's failureCode. */
  failureCode: string
  /** One Chinese line for the run's summary. */
  reason: string
  /** The error's own code (`git_unavailable`, `EACCES`), when it has one. */
  code?: string
  /** The error's message, sanitised and bounded. */
  message: string
}

const REASON_LIMIT = 300
const LOG_LIMIT = 1000

/**
 * An error's message as a log or summary may keep it: keys, tokens and
 * Authorization headers removed (and the run's own secret values), the home
 * folder written `~`, on one line, bounded.
 */
export function sanitizeFailureMessage(
  text: string,
  secrets: readonly string[] = [],
  limit = LOG_LIMIT,
): string {
  const home = homedir()
  let output = redactExecutorText(redactLogText(String(text ?? '')), secrets)
  if (home && home !== '/') output = output.split(home).join('~')
  output = output.replace(/\s+/gu, ' ').trim()
  const chars = [...output]
  return chars.length > limit
    ? chars.slice(0, limit - 1).join('') + '…'
    : output
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

function executorName(backend: ExternalBackend | string): string {
  return backend === 'claude-code' ? 'Claude Code' : 'Codex'
}

/** What failed, as the reason's opening words. */
function stageLabel(stage: RunStage, backend: string): string {
  const name = executorName(backend)
  switch (stage) {
    case 'budget':
      return '预留任务额度失败'
    case 'self-check':
      return `自检 ${name} 失败`
    case 'workspace':
      return '准备工作区失败'
    case 'lock':
      return '等待工作区失败'
    case 'runtime':
      return `准备 ${name} 的运行环境失败`
    case 'preflight':
      return `检查 ${name} 是否可用失败`
    case 'open':
      return `启动 ${name} 失败`
    case 'submit':
      return `把任务交给 ${name} 失败`
    case 'events':
      return `${name} 运行中出错`
  }
}

/** System error codes a spawn or file operation reports, in words. */
const ERRNO_HINTS: Readonly<Record<string, string>> = {
  EMFILE: '打开的文件太多',
  ENFILE: '打开的文件太多',
  EAGAIN: '系统暂时无法启动新进程',
  EACCES: '没有权限',
  EPERM: '没有权限',
  ENOENT: '找不到文件或程序',
  ENOSPC: '磁盘空间不足',
}

/** The system error behind an error: its code, or one its message names. */
function errnoOf(
  code: string | undefined,
  message: string,
): string | undefined {
  if (code && code in ERRNO_HINTS) return code
  return /\b(EMFILE|ENFILE|EAGAIN|EACCES|EPERM|ENOENT|ENOSPC)\b/.exec(
    message,
  )?.[1]
}

/**
 * A run's failure from an error that is not a DelegationError: its code
 * (workspace failures are specific, anything else stays EXECUTOR_ERROR),
 * its Chinese reason and its sanitised message.
 */
export function describeRunFailure(
  error: unknown,
  stage: RunStage,
  backend: ExternalBackend | string,
  secrets: readonly string[] = [],
): RunFailure {
  const code = errorCode(error)
  const message = sanitizeFailureMessage(errorMessage(error), secrets)
  let short = sanitizeFailureMessage(errorMessage(error), secrets, REASON_LIMIT)
  const label = stageLabel(stage, backend)
  // 「打开的文件太多（EMFILE）：spawn /usr/bin/git EMFILE」
  const errno = errnoOf(code, short)
  if (errno) short = `${ERRNO_HINTS[errno]}（${errno}）：${short}`
  let failureCode = 'EXECUTOR_ERROR',
    detail = short
  if (error instanceof WorkspaceOperationError) {
    if (code === 'git_unavailable') failureCode = 'WORKSPACE_GIT_UNAVAILABLE'
    else if (code === 'git_command_failed') {
      failureCode = 'WORKSPACE_GIT_FAILED'
      detail = `Git 命令失败：${short}`
    } else failureCode = 'WORKSPACE_PREPARE_FAILED'
  } else if (stage === 'workspace') failureCode = 'WORKSPACE_PREPARE_FAILED'
  return {
    failureCode,
    reason: detail ? `${label}：${detail}` : `${label}。`,
    ...(code ? { code } : {}),
    message,
  }
}

/**
 * What an executor reported when its turn failed (FIX-16), in one line:
 * the readable reason a run's summary opens with.
 */
export interface TurnFailure {
  /** Set when the failure is one Emperor names more precisely. */
  failureCode?: 'EXECUTOR_MODEL_UNSUPPORTED'
  /** One Chinese line for the run's summary. */
  reason: string
  /** The refused model, when the error or the run names it. */
  model?: string
}

const TURN_ERROR_LIMIT = 2000

/** An HTTP status in words, as the reason says it. */
function statusWords(status: number): string {
  const words: Readonly<Record<number, string>> = {
    400: '请求被拒绝',
    401: '认证失败',
    403: '没有权限',
    404: '找不到请求的内容',
    408: '请求超时',
    413: '请求太大',
    422: '请求无法处理',
    429: '被限流了',
    500: '服务暂时出错',
    502: '服务暂时出错',
    503: '服务暂时不可用',
    504: '服务响应超时',
    529: '服务过载',
  }
  return words[status] ?? (status >= 500 ? '服务端出错' : '请求失败')
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined
}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/**
 * An error payload inside a turn's error: OpenAI / Codex
 * `{status?, error: {type, code?, message}}`, Anthropic
 * `{type: 'error', error: {type, message}}`, or Claude Code's
 * `API Error: 404 {…}`.
 */
function errorPayload(
  raw: string,
):
  | { status?: number; type?: string; code?: string; message?: string }
  | undefined {
  const start = raw.indexOf('{'),
    end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  const inner = field(value, 'error')
  const status =
    [field(value, 'status'), field(inner, 'status')].find(
      (n): n is number => typeof n === 'number' && Number.isInteger(n),
    ) ??
    // 「API Error: 404 {…}」「unexpected status 400 Bad Request: {…}」
    Number(/\b([1-5]\d\d)\b/.exec(raw.slice(0, start))?.[1] ?? NaN)
  const type =
    text(field(inner, 'type')) ??
    (text(field(value, 'type')) !== 'error'
      ? text(field(value, 'type'))
      : undefined)
  const message =
    text(field(inner, 'message')) ??
    text(typeof inner === 'string' ? inner : undefined) ??
    text(field(value, 'message')) ??
    text(field(value, 'detail'))
  if (!message && !type) return undefined
  return {
    ...(Number.isInteger(status) ? { status } : {}),
    ...(type ? { type } : {}),
    ...(text(field(inner, 'code')) ? { code: text(field(inner, 'code')) } : {}),
    ...(message ? { message } : {}),
  }
}

/**
 * A provider refusing the model itself: Codex's 「The 'x' model is not
 * supported when using Codex with a ChatGPT account」, OpenAI's
 * `model_not_found`, Anthropic's 404 `model: x`, Claude Code's 「There's an
 * issue with the selected model (x)」.
 */
function refusedModel(
  message: string,
  payload: ReturnType<typeof errorPayload>,
): { model?: string } | undefined {
  const refused =
    payload?.code === 'model_not_found' ||
    /\bmodel\b[^.]{0,120}\bis not (?:supported|available)\b/i.test(message) ||
    /\bmodel\b[^.]{0,120}\bdoes not exist\b/i.test(message) ||
    /\bissue with the selected model\b/i.test(message) ||
    (payload?.type === 'not_found_error' && /^model:/i.test(message)) ||
    /\b(?:unsupported|invalid)[_ ]model\b/i.test(message)
  if (!refused) return undefined
  const model =
    /\bmodel\s+[`'"‘“]([^`'"’”\s]{1,128})[`'"’”]/i.exec(message)?.[1] ??
    /[`'"‘“]([^`'"’”\s]{1,128})[`'"’”]\s+model\b/i.exec(message)?.[1] ??
    /\bselected model \(([^)\s]{1,128})\)/i.exec(message)?.[1] ??
    /^model:\s*([\w.:/@-]{1,128})/i.exec(message)?.[1]
  return model ? { model } : {}
}

/** Structured-output refusals the adapters report by code. */
const TURN_ERROR_WORDS: Readonly<Record<string, string>> = {
  STRUCTURED_OUTPUT_INVALID: '返回的结构化结果不符合要求的格式',
}

/**
 * A failed turn's error (FIX-16) as the run's reason: a model the account
 * cannot use is EXECUTOR_MODEL_UNSUPPORTED and says which model and where
 * to change it; a JSON payload reads as what happened, its HTTP status and
 * type, and the provider's message; plain text follows 「… 这一轮失败：」.
 * Keys, tokens and the run's own secret values never reach it. Undefined
 * for an empty error.
 */
export function describeTurnError(
  error: string | undefined,
  backend: ExternalBackend | string,
  options: { model?: string; secrets?: readonly string[] } = {},
): TurnFailure | undefined {
  const raw = sanitizeFailureMessage(
    error ?? '',
    options.secrets,
    TURN_ERROR_LIMIT,
  )
  if (!raw) return undefined
  const name = executorName(backend)
  const payload = errorPayload(raw)
  const message = payload?.message ?? raw
  const refused = refusedModel(message, payload)
  if (refused) {
    const model = refused.model ?? text(options.model)
    const account = /\bChatGPT account\b/i.test(message)
      ? '（ChatGPT 账号登录）'
      : ''
    return {
      failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
      ...(model ? { model } : {}),
      reason:
        (model
          ? `${name} 不支持模型 ${model}${account}。`
          : `${name} 不支持当前使用的模型${account}。`) +
        `请在「设置 › 子智能体 › ${name} › 默认模型」里换一个可用的模型。`,
    }
  }
  const opening = `${name} 这一轮失败：`
  if (payload) {
    const facts = [
      ...(payload.status !== undefined ? [`HTTP ${payload.status}`] : []),
      ...(payload.type ? [payload.type] : []),
    ].join('，')
    const what =
      payload.status !== undefined ? statusWords(payload.status) : '返回错误'
    return {
      reason:
        opening +
        what +
        (facts ? `（${facts}）` : '') +
        (payload.message ? `：${payload.message}` : '。'),
    }
  }
  const words = TURN_ERROR_WORDS[raw]
  return { reason: opening + (words ? `${words}（${raw}）。` : raw) }
}

/**
 * What a claude loaded that Emperor does not allow (VER-02), as the run's
 * one Chinese line: a plugin from disk or a marketplace (`foreign`), a
 * builtin that stayed on after Emperor turned it off (`stuck`), an MCP
 * server, or plugins it could not load (`errors`).
 */
export type UnapprovedExtensions =
  | {
      kind: 'foreign'
      claudeVersion?: string
      plugins: readonly { name: string; path?: string; source?: string }[]
    }
  | { kind: 'stuck'; claudeVersion?: string; plugins: readonly string[] }
  | { kind: 'mcp'; servers: readonly string[] }
  | { kind: 'errors'; claudeVersion?: string; errorCount: number }

/** At most five names, then 「等 N 个」. */
function listed(names: readonly string[]): string {
  const shown = names.slice(0, 5).map((n) => sanitizeFailureMessage(n, [], 80))
  return names.length > shown.length
    ? `${shown.join('、')} 等 ${names.length} 个`
    : shown.join('、')
}

export function describeUnapprovedExtensions(
  input: UnapprovedExtensions,
): string {
  const claude =
    'claudeVersion' in input && input.claudeVersion
      ? `Claude Code ${sanitizeFailureMessage(input.claudeVersion, [], 32)}`
      : 'Claude Code'
  switch (input.kind) {
    case 'foreign':
      return `${claude} 加载了未批准的扩展：插件 ${listed(
        input.plugins.map((p) => {
          const where =
            p.path && p.path !== 'builtin'
              ? `（来自 ${sanitizeFailureMessage(p.path, [], 120)}）`
              : ''
          return (p.source ?? p.name) + where
        }),
      )}。Emperor 只允许它自带的内置插件，并会自动关闭它们。`
    case 'stuck':
      return `${claude} 的内置插件 ${listed(
        input.plugins.map((s) => s.replace(/@builtin$/u, '')),
      )} 关闭后仍在加载，可能是新版本改了开关。可以在 设置 › 子智能体 退回上一个正常版本。`
    case 'mcp':
      return `Claude Code 加载了 MCP server：${listed(input.servers)}。子智能体不允许使用 MCP。`
    case 'errors':
      return `${claude} 加载插件时报告了 ${input.errorCount} 个错误，Emperor 无法确认它加载了哪些扩展，没有启动这次任务。`
  }
}
