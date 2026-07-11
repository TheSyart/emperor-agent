import { describe, expect, it } from 'vitest'
import {
  normalizeDetectedVersion,
  parseVersionRequirement,
  versionSatisfies,
} from './version'

describe('environment numeric version requirements', () => {
  it('normalizes exact and partial ecosystem versions', () => {
    expect(normalizeDetectedVersion('v24.18.0')).toBe('24.18.0')
    expect(normalizeDetectedVersion('go1.26.5')).toBe('1.26.5')
    expect(parseVersionRequirement('3.12')).toMatchObject({
      status: 'supported',
      normalized: '>=3.12.0 <3.13.0',
    })
    expect(parseVersionRequirement('24')).toMatchObject({
      status: 'supported',
      normalized: '>=24.0.0 <25.0.0',
    })
  })

  it('supports comparator conjunctions, caret, tilde, commas, and stable fallback', () => {
    expect(parseVersionRequirement('>=3.12,<3.13')).toMatchObject({
      status: 'supported',
      normalized: '>=3.12.0 <3.13.0',
    })
    expect(versionSatisfies('3.12.13', '>=3.12,<3.13')).toBe(true)
    expect(versionSatisfies('3.13.0', '>=3.12,<3.13')).toBe(false)
    expect(versionSatisfies('22.5.0', '^22.0.0')).toBe(true)
    expect(versionSatisfies('23.0.0', '^22.0.0')).toBe(false)
    expect(versionSatisfies('24.4.1', '~24.4')).toBe(true)
    expect(versionSatisfies('24.5.0', '~24.4')).toBe(false)
    expect(
      parseVersionRequirement('stable', {
        allowStable: true,
        fallbackVersion: '1.97.0',
      }),
    ).toMatchObject({ status: 'supported', normalized: '=1.97.0' })
  })

  it('does not guess unsupported or malformed requirements', () => {
    expect(parseVersionRequirement('20 || 22').status).toBe('unsupported')
    expect(parseVersionRequirement('lts/*').status).toBe('unsupported')
    expect(parseVersionRequirement('=>3.12').status).toBe('invalid')
    expect(parseVersionRequirement('>=3.13 <3.12').status).toBe('invalid')
    expect(parseVersionRequirement('').status).toBe('invalid')
    expect(
      parseVersionRequirement('stable', { allowStable: true }).status,
    ).toBe('unsupported')
  })
})
