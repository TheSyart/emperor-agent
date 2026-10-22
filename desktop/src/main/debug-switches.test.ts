import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEBUG_SWITCH_REFUSED_EXIT, refusedDebugSwitch } from './debug-switches'

const has =
  (...present: string[]) =>
  (name: string) =>
    present.includes(name)

describe('DevTools switches of a packaged app (SEC-04)', () => {
  it('refuses the remote debugging port and pipe in a packaged app', () => {
    // No Electron fuse covers them: any local process could start Emperor
    // with one, attach to the main window and use its IPC bridge.
    for (const name of ['remote-debugging-port', 'remote-debugging-pipe'])
      expect(
        refusedDebugSwitch({ isPackaged: true, hasSwitch: has(name) }),
      ).toBe(name)
    expect(
      refusedDebugSwitch({ isPackaged: true, hasSwitch: has('lang') }),
    ).toBeNull()
  })

  it('exits 64 (EX_USAGE)', () => {
    expect(DEBUG_SWITCH_REFUSED_EXIT).toBe(64)
  })

  it('keeps them for development (Playwright drives the dev build)', () => {
    expect(
      refusedDebugSwitch({
        isPackaged: false,
        hasSwitch: has('remote-debugging-port'),
      }),
    ).toBeNull()
  })

  it('is checked before anything starts', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    const guard = source.indexOf('refusedDebugSwitch({')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(source.indexOf('app.whenReady()'))
    expect(guard).toBeLessThan(
      source.indexOf('packagedSmokeLaunch(process.argv'),
    )
  })
})
