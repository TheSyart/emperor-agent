import { describe, expect, it } from 'vitest'
import { ToolError } from '../tools/definition'
import {
  asUiError,
  isUiErrorCode,
  UI_ERROR_CODES,
  UiError,
  uiErrorLine,
} from './errors'

describe('computer use error codes', () => {
  it('covers the spec §5.6 table', () => {
    expect(Object.keys(UI_ERROR_CODES).sort()).toEqual(
      [
        'BUDGET_EXCEEDED',
        'CAPABILITY_DISABLED',
        'DRIVER_UNAVAILABLE',
        'INVALID_REQUEST',
        'OUTCOME_UNKNOWN',
        'PERMISSION_DENIED',
        'PERMISSION_REQUIRED',
        'PLAN_MODE_ACTION_DENIED',
        'PROTOCOL_MISMATCH',
        'SECURE_INPUT_ACTIVE',
        'STALE_ELEMENT',
        'STALE_TARGET',
        'TARGET_BUSY',
        'TARGET_FORBIDDEN',
        'TARGET_NOT_VISIBLE',
        'TIMEOUT_NO_EFFECT',
        'USER_TAKEOVER',
        'VISION_UNAVAILABLE',
      ].sort(),
    )
  })

  it('only lets stale and no-effect timeouts be retried', () => {
    const retryable = Object.entries(UI_ERROR_CODES)
      .filter(([, spec]) => spec.retryable)
      .map(([code]) => code)
      .sort()
    expect(retryable).toEqual([
      'STALE_ELEMENT',
      'STALE_TARGET',
      'TIMEOUT_NO_EFFECT',
    ])
    expect(UI_ERROR_CODES.OUTCOME_UNKNOWN.retryable).toBe(false)
  })

  it('carries code, retry flag, hint and reason', () => {
    const error = new UiError('PERMISSION_DENIED', 'binding mismatch', {
      reason: 'credential-binding-mismatch',
    })
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(error.toPayload()).toEqual({
      code: 'PERMISSION_DENIED',
      message: 'binding mismatch',
      retryable: false,
      hint: UI_ERROR_CODES.PERMISSION_DENIED.hint,
      reason: 'credential-binding-mismatch',
    })
    expect(uiErrorLine(error)).toBe(
      `computer-use PERMISSION_DENIED: binding mismatch (retryable: false; reason: credential-binding-mismatch; hint: ${UI_ERROR_CODES.PERMISSION_DENIED.hint})`,
    )
  })

  it('normalizes foreign errors', () => {
    const wrapped = asUiError(new Error('socket closed'))
    expect(wrapped.code).toBe('DRIVER_UNAVAILABLE')
    expect(wrapped.message).toBe('socket closed')
    const same = new UiError('STALE_TARGET', 'moved')
    expect(asUiError(same)).toBe(same)
    expect(isUiErrorCode('STALE_TARGET')).toBe(true)
    expect(isUiErrorCode('toString')).toBe(false)
  })
})
