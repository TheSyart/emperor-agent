// KRN-13 (finding CORE-43): Emperor's own socket folders, which the Shell's
// Seatbelt profile denies, follow the Emperor Home in use — with a custom
// EMPEROR_CONFIG_DIR that home's `run` is denied. The default home's stays
// denied too: a development instance's Shell must not reach the sockets of
// the Emperor installed on the same Mac.
import { realpathSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shellContainmentPolicy } from '../harness/sandbox/backend'
import { emperorSocketDirectories } from './policy'

describe('Emperor socket folders (KRN-13)', () => {
  it('7 · with a custom Emperor Home the Shell denies that home’s run folder', () => {
    const home = realpathSync(
      mkdtempSync(join(tmpdir(), 'emperor-krn13-home-')),
    )
    const policy = shellContainmentPolicy(
      { mode: 'workspace-write', writableRoots: [home] } as never,
      home,
    )
    expect(policy.deniedSocketDirs).toContain(join(home, 'run'))
    expect(emperorSocketDirectories(home)).toContain(join(home, 'run'))
    expect(emperorSocketDirectories(home)).toContain(
      join(realpathSync(homedir()), '.emperor', 'run'),
    )
  })

  it('without a known home the default Emperor Home is used', () => {
    expect(emperorSocketDirectories(null)).toContain(
      join(realpathSync(homedir()), '.emperor', 'run'),
    )
  })
})
