import { describe, expect, it, vi } from 'vitest'
import { createBackupExclusion } from './backup-exclusion'

describe('Time Machine exclusion (SEC-10)', () => {
  it('runs tmutil addexclusion by its absolute path on macOS', async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        callback: (error: Error | null) => void,
      ) => callback(null),
    )
    await createBackupExclusion({ platform: 'darwin', execFile })(
      '/Users/me/.emperor/browser/profiles/p_0123456789ab',
    )
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/tmutil',
      ['addexclusion', '/Users/me/.emperor/browser/profiles/p_0123456789ab'],
      expect.any(Function),
    )
  })

  it('reports a failure, and does nothing elsewhere', async () => {
    const failing = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        callback: (error: Error | null) => void,
      ) => callback(new Error('tmutil: not permitted')),
    )
    await expect(
      createBackupExclusion({ platform: 'darwin', execFile: failing })('/x'),
    ).rejects.toThrow('not permitted')
    const never = vi.fn()
    await createBackupExclusion({ platform: 'linux', execFile: never })('/x')
    expect(never).not.toHaveBeenCalled()
  })
})
