import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startCrashReporting } from './crash-reporting'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('local crash dumps (REL-01)', () => {
  it('points Crashpad at the log folder before starting it, uploads off', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-crash-'))
    roots.push(root)
    const dir = join(root, 'logs', 'Crashpad')
    const calls: unknown[][] = []
    startCrashReporting({
      dir,
      app: { setPath: (name, value) => calls.push(['setPath', name, value]) },
      crashReporter: { start: (options) => calls.push(['start', options]) },
    })
    expect(calls).toEqual([
      ['setPath', 'crashDumps', dir],
      [
        'start',
        {
          productName: 'Emperor Agent',
          uploadToServer: false,
          ignoreSystemCrashHandler: false,
          compress: true,
        },
      ],
    ])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('reports a failure instead of stopping the app', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-crash-'))
    roots.push(root)
    const result = startCrashReporting({
      dir: join(root, 'Crashpad'),
      app: { setPath: () => undefined },
      crashReporter: {
        start: () => {
          throw new Error('crashpad handler missing')
        },
      },
    })
    expect(result).toEqual({ ok: false, error: 'crashpad handler missing' })
  })
})
