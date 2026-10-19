import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareStableProcessStartIdentity,
  currentStableProcessIdentity,
  stableProcessStartIdentity,
  systemBootMarker,
} from './stable-process-identity'

describe('currentStableProcessIdentity', () => {
  it('caches the immutable current-process identity for the process lifetime', () => {
    const first = currentStableProcessIdentity()
    const second = currentStableProcessIdentity()

    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    if (first.bootMarker === null) expect(first.processStartIdentity).toBeNull()
    else expect(first.processStartIdentity).not.toBeNull()
  })
})

describe('systemBootMarker', () => {
  it.skipIf(process.platform !== 'darwin')(
    'binds Darwin identity to the stable boot session UUID',
    () => {
      const bootSessionUuid = execFileSync(
        '/usr/sbin/sysctl',
        ['-n', 'kern.bootsessionuuid'],
        { encoding: 'utf8' },
      )
        .trim()
        .toLowerCase()
      const expected = createHash('sha256')
        .update(`darwin:${bootSessionUuid}`, 'utf8')
        .digest('hex')

      expect(systemBootMarker()).toBe(expected)
    },
  )
})

describe('system tools (SEC-04)', () => {
  it.skipIf(process.platform !== 'darwin')(
    'reads the boot marker and process start with /usr/sbin/sysctl and /bin/ps, not PATH',
    () => {
      const bin = mkdtempSync(join(tmpdir(), 'emperor-fake-tools-'))
      const marker = join(bin, 'fake-tool-ran')
      const saved = process.env.PATH
      try {
        for (const tool of ['sysctl', 'ps']) {
          writeFileSync(
            join(bin, tool),
            `#!/bin/sh\ntouch '${marker}'\necho 00000000-0000-4000-8000-000000000000\n`,
          )
          chmodSync(join(bin, tool), 0o755)
        }
        process.env.PATH = `${bin}:${saved ?? ''}`
        const expected = createHash('sha256')
          .update(
            `darwin:${execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim().toLowerCase()}`,
            'utf8',
          )
          .digest('hex')
        expect(systemBootMarker()).toBe(expected)
        expect(stableProcessStartIdentity(process.pid)).toMatchObject({
          kind: 'darwin_boot_relative_interval',
        })
        expect(existsSync(marker)).toBe(false)
      } finally {
        process.env.PATH = saved
        rmSync(bin, { recursive: true, force: true })
      }
    },
  )
})

describe('compareStableProcessStartIdentity', () => {
  it('does not call near-boundary Darwin samples a proven PID reuse', () => {
    expect(
      compareStableProcessStartIdentity(
        {
          kind: 'darwin_boot_relative_interval',
          minSeconds: 100,
          maxSeconds: 101,
        },
        {
          kind: 'darwin_boot_relative_interval',
          minSeconds: 101.25,
          maxSeconds: 102.25,
        },
      ),
    ).toBe('ambiguous')
  })
})
