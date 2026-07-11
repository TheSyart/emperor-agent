import { describe, expect, it } from 'vitest'
import { toSafeError } from '../errors'
import {
  ENVIRONMENT_ERROR_CODES,
  EnvironmentError,
  environmentErrorDescriptor,
  environmentSafeErrorSchema,
} from './errors'

describe('Environment safe errors', () => {
  it('defines a Chinese summary and recovery action for every stable code', () => {
    expect(ENVIRONMENT_ERROR_CODES).toHaveLength(20)
    for (const code of ENVIRONMENT_ERROR_CODES) {
      const descriptor = environmentErrorDescriptor(code)
      expect(descriptor.message).toMatch(/[\u4e00-\u9fff]/)
      expect(descriptor.action).toMatch(/^[a-z][a-z0-9_]+$/)
      expect(environmentSafeErrorSchema.parse({ code, ...descriptor })).toEqual(
        { code, ...descriptor },
      )
    }
  })

  it('never exposes internal detail, command lines, or stack in safe payloads', () => {
    const error = new EnvironmentError('integrity_failed', {
      cause: new Error('secret-token curl https://example.com?token=abc'),
      detail: 'sha mismatch at /Users/private/download',
    })
    const safe = toSafeError(error)

    expect(safe).toEqual({
      code: 'integrity_failed',
      message: environmentErrorDescriptor('integrity_failed').message,
      action: environmentErrorDescriptor('integrity_failed').action,
    })
    expect(JSON.stringify(safe)).not.toMatch(/secret|curl|Users|token=abc/i)
  })
})
