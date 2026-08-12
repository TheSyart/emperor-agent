/**
 * 结构化日志。
 *
 * 零依赖 console 封装，保留 level 过滤与结构化字段；
 * 后续可在不改调用点的前提下换成 pino/consola。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  bindings?: Record<string, unknown>
  /** 注入 sink，便于测试；默认 console。 */
  sink?: (line: {
    level: LogLevel
    msg: string
    fields: Record<string, unknown>
  }) => void
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level =
    opts.level ?? (process.env.EMPEROR_LOG_LEVEL as LogLevel) ?? 'info'
  const bindings = opts.bindings ?? {}
  const sink =
    opts.sink ??
    ((line) => {
      const payload = Object.keys(line.fields).length ? line.fields : undefined

      const fn =
        line.level === 'debug'
          ? console.debug
          : line.level === 'warn'
            ? console.warn
            : line.level === 'error'
              ? console.error
              : console.info
      fn(`[${line.level}] ${line.msg}`, payload ?? '')
    })

  const emit = (
    lvl: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (ORDER[lvl] < ORDER[level]) return
    sink({ level: lvl, msg, fields: { ...bindings, ...(fields ?? {}) } })
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) =>
      createLogger({ level, bindings: { ...bindings, ...extra }, sink }),
  }
}

/** 进程默认 logger。 */
export const logger: Logger = createLogger()
