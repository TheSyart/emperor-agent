import { describe, expect, it } from 'vitest'
import { createLoadFailurePolicy, ERR_ABORTED } from './load-failure'

describe('main window load failures (MAIN-18)', () => {
  it('ignores subframes and aborted loads (a reload aborts the old one)', () => {
    const policy = createLoadFailurePolicy()
    expect(policy.onFail(-105, false)).toBe('ignore')
    expect(policy.onFail(ERR_ABORTED, true)).toBe('ignore')
    expect(policy.onFail(ERR_ABORTED, true)).toBe('ignore')
  })

  it('retries once, then gives up', () => {
    const policy = createLoadFailurePolicy()
    expect(policy.onFail(-102, true)).toBe('retry')
    expect(policy.onFail(-102, true)).toBe('fail')
  })

  it('forgets earlier failures after a page loads', () => {
    const policy = createLoadFailurePolicy()
    expect(policy.onFail(-102, true)).toBe('retry')
    policy.onLoaded()
    expect(policy.onFail(-102, true)).toBe('retry')
  })
})
