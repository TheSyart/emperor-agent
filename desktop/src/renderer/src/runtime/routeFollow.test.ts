import { describe, expect, it } from 'vitest'
import { isStaleDraftRoute, shouldFollowActiveSession } from './routeFollow'

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

// FIX-08: drafts live only in the window's memory. After a reload the route
// still names the old draft, nobody knows it, and the view said 「没有找到这个
// 会话。」 with a composer that could not send.
describe('isStaleDraftRoute', () => {
  it('is a draft id the store no longer knows (the window reloaded)', () => {
    expect(
      isStaleDraftRoute({
        routeSessionId: 'draft:before-reload',
        routeSessionKnown: false,
        routeSessionIsDraft: true,
      }),
    ).toBe(true)
  })

  it('is not the draft on screen, a real session or a child session', () => {
    expect(
      isStaleDraftRoute({
        routeSessionId: 'draft:current',
        routeSessionKnown: true,
        routeSessionIsDraft: true,
      }),
    ).toBe(false)
    expect(
      isStaleDraftRoute({
        routeSessionId: 'session-a',
        routeSessionKnown: true,
        routeSessionIsDraft: false,
      }),
    ).toBe(false)
    expect(
      isStaleDraftRoute({
        routeSessionId: 'child-session',
        routeSessionKnown: false,
        routeSessionIsDraft: false,
      }),
    ).toBe(false)
    expect(
      isStaleDraftRoute({
        routeSessionId: '',
        routeSessionKnown: false,
        routeSessionIsDraft: false,
      }),
    ).toBe(false)
  })
})
