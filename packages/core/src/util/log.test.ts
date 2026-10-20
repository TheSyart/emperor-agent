import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLogger,
  logger,
  setCoreLogSink,
  type LogLevel,
  type LogLine,
} from './log'

function capture(level: LogLevel) {
  const lines: {
    level: LogLevel
    msg: string
    fields: Record<string, unknown>
  }[] = []
  const log = createLogger({ level, sink: (l) => lines.push(l) })
  return { log, lines }
}

describe('log', () => {
  it('filters below the configured level', () => {
    const { log, lines } = capture('warn')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error'])
  })

  it('merges child bindings into fields', () => {
    const { log, lines } = capture('debug')
    log.child({ area: 'providers' }).info('hello', { n: 1 })
    expect(lines[0]?.fields).toEqual({ area: 'providers', n: 1 })
  })

  it('default sink routes to console without throwing', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    createLogger({ level: 'info' }).info('x')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('the process sink (REL-01 core.log)', () => {
  afterEach(() => setCoreLogSink(null))

  it('sends the shared logger and its children to the installed sink', () => {
    const child = logger.child({ area: 'mcp' })
    const lines: LogLine[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setCoreLogSink((line) => lines.push(line))
    logger.warn('scheduler tick failed', { error: 'boom' })
    child.error('server crashed', { server: 'fs' })
    expect(lines).toEqual([
      {
        level: 'warn',
        msg: 'scheduler tick failed',
        fields: { error: 'boom' },
      },
      {
        level: 'error',
        msg: 'server crashed',
        fields: { area: 'mcp', server: 'fs' },
      },
    ])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('falls back to the console once the sink is removed', () => {
    const lines: LogLine[] = []
    setCoreLogSink((line) => lines.push(line))
    setCoreLogSink(null)
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logger.warn('after')
    expect(lines).toEqual([])
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('keeps a logger with its own sink on that sink', () => {
    const own: LogLine[] = []
    const installed: LogLine[] = []
    setCoreLogSink((line) => installed.push(line))
    createLogger({ level: 'info', sink: (line) => own.push(line) }).info('x')
    expect(own).toHaveLength(1)
    expect(installed).toEqual([])
  })
})
