import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppLog, describeError, teeConsole } from './app-log'

const roots: string[] = []
function logFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'emperor-app-log-'))
  roots.push(root)
  return join(root, 'main.log')
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const at = () => new Date('2026-10-20T08:00:00.000Z')

describe('main.log lines (REL-01)', () => {
  it('writes time, level, message and fields; info is the floor', () => {
    const file = logFile()
    const log = createAppLog({ file, now: at })
    log.debug('not kept')
    log.info('Emperor Agent starting', { version: '0.2.0', packaged: true })
    log.warn('Chrome/Edge connection unavailable')
    log.close()
    expect(readFileSync(file, 'utf8')).toBe(
      '2026-10-20T08:00:00.000Z [info] Emperor Agent starting {"version":"0.2.0","packaged":true}\n' +
        '2026-10-20T08:00:00.000Z [warn] Chrome/Edge connection unavailable\n',
    )
  })

  it('replaces sk- keys with sk-*** and hides tokens before they reach the file', () => {
    const file = logFile()
    const log = createAppLog({ file, now: at })
    log.error(
      'request failed sk-abc123def456 for https://api.x.dev/v1?key=sk-abc123def456',
      {
        headers: { Authorization: 'Bearer sk-abc123def456' },
      },
    )
    log.close()
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(
      'request failed sk-*** for https://api.x.dev/v1?key=***',
    )
    expect(text).toContain('"Authorization":"***"')
    expect(text).not.toContain('abc123def456')
  })

  it('writes an error with its whole stack and the cause behind it', () => {
    const file = logFile()
    const log = createAppLog({ file, now: at })
    const cause = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    })
    const error = Object.assign(
      new Error('installation.json is invalid', { cause }),
      { code: 'installation_invalid_state' },
    )
    log.error('Emperor startup failed', { error })
    log.close()
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('[error] Emperor startup failed')
    expect(text).toContain('Error: installation.json is invalid')
    expect(text).toContain('code: installation_invalid_state')
    expect(text).toContain('Caused by: Error: EACCES: permission denied')
    // Stack frames of both, on their own lines.
    expect(text.match(/\n\s+at /g)?.length ?? 0).toBeGreaterThan(2)
    expect(text).toContain(__filename.split('/').pop()!)
  })

  it('describes thrown non-errors too', () => {
    expect(describeError('plain text')).toBe('plain text')
    expect(describeError({ reason: 'x' })).toBe('{"reason":"x"}')
    expect(describeError(undefined)).toBe('undefined')
  })

  it('follows EMPEROR_LOG_LEVEL-style levels', () => {
    const file = logFile()
    const log = createAppLog({ file, level: 'warn', now: at })
    log.info('dropped')
    log.error('kept')
    log.close()
    expect(readFileSync(file, 'utf8')).toBe(
      '2026-10-20T08:00:00.000Z [error] kept\n',
    )
  })
})

describe('console output into main.log', () => {
  it('copies console lines to the log and still prints them', () => {
    const file = logFile()
    const log = createAppLog({ file, now: at })
    const printed: unknown[][] = []
    const target = {
      log: (...args: unknown[]) => printed.push(['log', ...args]),
      info: (...args: unknown[]) => printed.push(['info', ...args]),
      warn: (...args: unknown[]) => printed.push(['warn', ...args]),
      error: (...args: unknown[]) => printed.push(['error', ...args]),
      debug: (...args: unknown[]) => printed.push(['debug', ...args]),
    }
    const restore = teeConsole(target, log)
    target.warn('Credential vault unavailable: key-missing')
    target.error('failed to open', new Error('boom'))
    target.info('[browser-import] imported', { passwords: 2 })
    target.debug('chatty')
    restore()
    target.error('after restore')
    log.close()
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('[warn] Credential vault unavailable: key-missing')
    expect(text).toContain('[error] failed to open Error: boom')
    expect(text).toContain('[info] [browser-import] imported {"passwords":2}')
    expect(text).not.toContain('chatty')
    expect(text).not.toContain('after restore')
    expect(printed.map((entry) => entry[0])).toEqual([
      'warn',
      'error',
      'info',
      'debug',
      'error',
    ])
  })

  it('survives a console that throws (a closed stdout)', () => {
    const file = logFile()
    const log = createAppLog({ file, now: at })
    const broken = vi.fn((..._args: unknown[]): void => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    })
    const target = {
      log: broken,
      info: broken,
      warn: broken,
      error: broken,
      debug: broken,
    }
    teeConsole(target, log)
    expect(() => target.error('still logged')).not.toThrow()
    log.close()
    expect(readFileSync(file, 'utf8')).toContain('[error] still logged')
  })
})
