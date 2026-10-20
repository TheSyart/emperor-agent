import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { checkStartupLog } = require(
  resolve(__dirname, '..', '..', 'scripts', 'packaged-log-check.cjs'),
) as {
  checkStartupLog(stateRoot: string): {
    path: string
    bytes: number
    startLine: string
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function stateRoot(log?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'emperor-smoke-log-'))
  roots.push(root)
  if (log !== undefined) {
    mkdirSync(join(root, 'logs'), { recursive: true })
    writeFileSync(join(root, 'logs', 'main.log'), log)
  }
  return root
}

describe('packaged smoke: main.log (REL-01 test 1)', () => {
  it('finds the startup record of the packaged app', () => {
    const root = stateRoot(
      '2026-10-20T08:00:00.000Z [info] Emperor Agent 0.2.0 starting {"packaged":true}\n' +
        '2026-10-20T08:00:02.000Z [info] Core ready\n',
    )
    expect(checkStartupLog(root)).toEqual({
      path: join(root, 'logs', 'main.log'),
      bytes: 122,
      startLine:
        '2026-10-20T08:00:00.000Z [info] Emperor Agent 0.2.0 starting {"packaged":true}',
    })
  })

  it('fails without main.log or without a startup record', () => {
    expect(() => checkStartupLog(stateRoot())).toThrow(/main\.log is missing/)
    expect(() =>
      checkStartupLog(stateRoot('2026-10-20T08:00:00.000Z [warn] other\n')),
    ).toThrow(/no startup record/)
  })
})
