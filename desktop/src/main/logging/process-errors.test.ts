import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installProcessErrorHandlers } from './process-errors'

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    exit: ReturnType<typeof vi.fn>
    stdout: EventEmitter
    stderr: EventEmitter
  }
  proc.exit = vi.fn()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  return proc
}

function fakeLog() {
  const lines: Array<{ level: string; msg: string; fields?: unknown }> = []
  return {
    lines,
    error: (msg: string, fields?: Record<string, unknown>) =>
      lines.push({ level: 'error', msg, fields }),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      lines.push({ level: 'warn', msg, fields }),
  }
}

describe('uncaught errors in main (REL-01 test 5)', () => {
  it('logs an uncaught exception and keeps the process running', () => {
    const proc = fakeProcess()
    const log = fakeLog()
    installProcessErrorHandlers({ process: proc, log })
    const error = new Error('stray timer threw')
    proc.emit('uncaughtException', error, 'uncaughtException')
    expect(log.lines).toEqual([
      {
        level: 'error',
        msg: 'uncaught exception (main keeps running)',
        fields: { origin: 'uncaughtException', error },
      },
    ])
    expect(proc.exit).not.toHaveBeenCalled()
    expect(proc.listenerCount('uncaughtException')).toBe(1)
  })

  it('logs an unhandled rejection with its reason', () => {
    const proc = fakeProcess()
    const log = fakeLog()
    installProcessErrorHandlers({ process: proc, log })
    proc.emit('unhandledRejection', 'socket closed', Promise.resolve())
    expect(log.lines).toEqual([
      {
        level: 'error',
        msg: 'unhandled rejection (main keeps running)',
        fields: { reason: 'socket closed' },
      },
    ])
    expect(proc.exit).not.toHaveBeenCalled()
  })

  it('keeps a storm of the same error from flooding the log', () => {
    let now = 0
    const proc = fakeProcess()
    const log = fakeLog()
    installProcessErrorHandlers({
      process: proc,
      log,
      now: () => now,
      maxPerMinute: 5,
    })
    for (let index = 0; index < 50; index += 1)
      proc.emit('uncaughtException', new Error(`tick ${index}`), 'x')
    expect(log.lines).toHaveLength(5)
    now = 61_000
    proc.emit('uncaughtException', new Error('later'), 'x')
    expect(log.lines.slice(5).map((line) => line.msg)).toEqual([
      'suppressed 45 uncaught errors in the last minute',
      'uncaught exception (main keeps running)',
    ])
  })

  it('ignores a closed stdout or stderr instead of looping on EPIPE', () => {
    const proc = fakeProcess()
    const log = fakeLog()
    installProcessErrorHandlers({ process: proc, log })
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => proc.stdout.emit('error', epipe)).not.toThrow()
    expect(() => proc.stderr.emit('error', epipe)).not.toThrow()
    expect(log.lines).toEqual([])
    const other = Object.assign(new Error('EBADF'), { code: 'EBADF' })
    proc.stdout.emit('error', other)
    expect(log.lines).toEqual([
      { level: 'warn', msg: 'stdout failed', fields: { error: other } },
    ])
  })

  it('removes its handlers when asked', () => {
    const proc = fakeProcess()
    const uninstall = installProcessErrorHandlers({
      process: proc,
      log: fakeLog(),
    })
    uninstall()
    expect(proc.listenerCount('uncaughtException')).toBe(0)
    expect(proc.listenerCount('unhandledRejection')).toBe(0)
    expect(proc.stdout.listenerCount('error')).toBe(0)
  })
})
