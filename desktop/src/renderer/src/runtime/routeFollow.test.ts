import { describe, expect, it } from 'vitest'
import { shouldFollowActiveSession } from './routeFollow'

const base = {
  routeSessionId: 'session-a',
  activeId: 'session-a',
  routeSessionKnown: true,
  routeSessionIsDraft: false,
}

describe('shouldFollowActiveSession', () => {
  it('stays put when the route already shows the active session', () => {
    expect(shouldFollowActiveSession(base)).toBe(false)
  })

  it('follows when the active session moved to another known session', () => {
    expect(shouldFollowActiveSession({ ...base, activeId: 'session-b' })).toBe(
      true,
    )
  })

  it('follows a promoted draft whose row the store already replaced', () => {
    expect(
      shouldFollowActiveSession({
        routeSessionId: 'draft:abc',
        activeId: 'session-real',
        routeSessionKnown: false,
        routeSessionIsDraft: true,
      }),
    ).toBe(true)
  })

  it('leaves a child session on screen while the active session changes', () => {
    expect(
      shouldFollowActiveSession({
        routeSessionId: 'child-session',
        activeId: 'session-b',
        routeSessionKnown: false,
        routeSessionIsDraft: false,
      }),
    ).toBe(false)
  })

  it('fills an empty route from the active session', () => {
    expect(
      shouldFollowActiveSession({
        routeSessionId: '',
        activeId: 'session-a',
        routeSessionKnown: false,
        routeSessionIsDraft: false,
      }),
    ).toBe(true)
  })

  it('does nothing without an active session', () => {
    expect(shouldFollowActiveSession({ ...base, activeId: '' })).toBe(false)
  })
})
