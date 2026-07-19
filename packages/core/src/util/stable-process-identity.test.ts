import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  compareStableProcessStartIdentity,
  currentStableProcessIdentity,
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
        'sysctl',
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
