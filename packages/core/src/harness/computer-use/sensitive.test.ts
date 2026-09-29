import { describe, expect, it } from 'vitest'
import { looksSensitive, maskedValue } from './sensitive'

describe('sensitive field labels', () => {
  it.each([
    'user_pass',
    'Password',
    'totp-input',
    'one-time code',
    'verification_code',
    'CVV',
    'PIN',
    '密码',
    '短信验证码',
    '动态码',
  ])('flags %s', (label) => expect(looksSensitive(label)).toBe(true))

  it.each(['Email', 'username', 'spinner', 'company', 'Search', ''])(
    'leaves %s alone',
    (label) => expect(looksSensitive(label)).toBe(false),
  )

  it('checks every label and masks only non-empty values', () => {
    expect(looksSensitive(undefined, 'name', 'otp')).toBe(true)
    expect(maskedValue('')).toBe('')
    expect(maskedValue('x')).toBe('[has content]')
  })
})
