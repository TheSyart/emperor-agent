import { describe, expect, it } from 'vitest'
import { resolveLogLocation } from './log-location'

describe('where Emperor writes its logs (REL-01)', () => {
  it('uses ~/Library/Logs/Emperor Agent for the real Emperor Home', () => {
    expect(
      resolveLogLocation({
        stateRoot: '/Users/me/.emperor',
        stateRootSource: 'default',
        homeDir: '/Users/me',
        platform: 'darwin',
      }),
    ).toEqual({
      dir: '/Users/me/Library/Logs/Emperor Agent',
      mainLog: '/Users/me/Library/Logs/Emperor Agent/main.log',
      coreLog: '/Users/me/Library/Logs/Emperor Agent/core.log',
      crashDumps: '/Users/me/Library/Logs/Emperor Agent/Crashpad',
      source: 'default',
    })
  })

  it('keeps logs and crash dumps inside an EMPEROR_CONFIG_DIR home', () => {
    // Tests, e2e runs and the packaged smoke set EMPEROR_CONFIG_DIR, so
    // they never write to the user's real ~/Library/Logs.
    expect(
      resolveLogLocation({
        stateRoot: '/tmp/emperor-e2e-x',
        stateRootSource: 'env',
        homeDir: '/Users/me',
        platform: 'darwin',
      }),
    ).toEqual({
      dir: '/tmp/emperor-e2e-x/logs',
      mainLog: '/tmp/emperor-e2e-x/logs/main.log',
      coreLog: '/tmp/emperor-e2e-x/logs/core.log',
      crashDumps: '/tmp/emperor-e2e-x/logs/Crashpad',
      source: 'state-root',
    })
  })

  it("falls back to the system's log folder off macOS", () => {
    expect(
      resolveLogLocation({
        stateRoot: '/home/me/.emperor',
        stateRootSource: 'default',
        homeDir: '/home/me',
        platform: 'linux',
        systemLogs: '/home/me/.config/Emperor Agent/logs',
      }).dir,
    ).toBe('/home/me/.config/Emperor Agent/logs')
  })
})
