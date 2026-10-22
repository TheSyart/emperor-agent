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
