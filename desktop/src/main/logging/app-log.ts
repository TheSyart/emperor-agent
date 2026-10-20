/**
 * main.log and core.log (REL-01): one line per entry, `<ISO time> [level]
 * message {fields}`, an Error written with its whole stack and every
 * `cause` behind it. Every line goes through `redactLogText` before it is
 * written: `sk-` keys become `sk-***`, URL tokens and Authorization headers
 * `***`. The floor is info (`EMPEROR_LOG_LEVEL` may change it).
 */
import { inspect } from 'node:util'
import { redactLogText } from '@emperor/core/host-capabilities'
import { RotatingFile } from './rotating-file'

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<AppLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface AppLog {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  /** The line as written, for any level (core.log's sink uses it). */
  write(level: AppLogLevel, msg: string, fields?: Record<string, unknown>): void
  readonly file: string
  close(): void
}

export function logLevelOf(value: string | undefined): AppLogLevel {
  return value === 'debug' || value === 'warn' || value === 'error'
    ? value
    : 'info'
}

export function createAppLog(options: {
  file: string
  level?: AppLogLevel
  now?: () => Date
  maxBytes?: number
  maxFiles?: number
}): AppLog {
  const floor = ORDER[options.level ?? 'info']
  const now = options.now ?? (() => new Date())
  const out = new RotatingFile({
    path: options.file,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxFiles ? { maxFiles: options.maxFiles } : {}),
  })
  const write: AppLog['write'] = (level, msg, fields) => {
    if (ORDER[level] < floor) return
    out.write(`${formatEntry(now(), level, msg, fields)}\n`)
  }
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    write,
    file: options.file,
    close: () => out.close(),
  }
}

function formatEntry(
  time: Date,
  level: AppLogLevel,
  msg: string,
  fields: Record<string, unknown> | undefined,
): string {
  const errors: string[] = []
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value instanceof Error) errors.push(describeError(value))
    else plain[key] = value
  }
  let line = `${time.toISOString()} [${level}] ${msg}`
  if (Object.keys(plain).length) line += ` ${safeJson(plain)}`
  for (const error of errors) line += `\n${indent(error)}`
  return redactLogText(line)
}

/** An error's stack (or message), its code, and each cause behind it. */
export function describeError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) {
    if (typeof error === 'string') return error
    if (error === undefined) return 'undefined'
    return safeJson(error)
  }
  const parts = [error.stack || `${error.name}: ${error.message}`]
  const code = (error as { code?: unknown }).code
  if (code !== undefined && code !== null && code !== '')
    parts.push(`code: ${String(code)}`)
  const cause = (error as { cause?: unknown }).cause
  if (cause !== undefined && depth < 5)
    parts.push(`Caused by: ${describeError(cause, depth + 1)}`)
  return parts.join('\n')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map(
      (line) =>
        `    ${line.trimStart().startsWith('at ') ? '  ' : ''}${line.trimStart()}`,
    )
    .join('\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return inspect(value, { depth: 3, breakLength: Infinity })
  }
}

interface ConsoleLike {
  log(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

const CONSOLE_LEVELS: ReadonlyArray<[keyof ConsoleLike, AppLogLevel]> = [
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
  ['debug', 'debug'],
]

/**
 * Copy what main prints with `console.*` into main.log; the console still
 * prints it (a closed stdout is ignored). Returns the undo.
 */
export function teeConsole(target: ConsoleLike, log: AppLog): () => void {
  const originals = CONSOLE_LEVELS.map(
    ([method]) => [method, target[method]] as const,
  )
  for (const [method, level] of CONSOLE_LEVELS) {
    const original = target[method]
    target[method] = (...args: unknown[]) => {
      try {
        log.write(level, args.map(consoleText).join(' '))
      } catch {
        // never let logging break the caller
      }
      try {
        original.apply(target, args)
      } catch {
        // a closed stdout (EPIPE) is not the caller's problem
      }
    }
  }
  return () => {
    for (const [method, original] of originals) target[method] = original
  }
}

function consoleText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  return safeJson(value)
}
