import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../types'
import {
  conversationCrumbs,
  conversationPhase,
  sessionRunning,
  isChildLineage,
} from './conversationModel'

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    title: '重构设置页',
    created_at: '',
    updated_at: '',
    preview: '',
    version: 1,
    ...overrides,
  }
}

describe('conversation shell model', () => {
  it.each(['cold', 'opening', 'error'] as const)(
    'keeps an existing session in conversation layout while history is %s',
    (historyState) => {
      expect(
        conversationPhase({
          composer: 'blank',
          child: false,
          tab: 'chat',
          historyState,
        }),
      ).toBe('active')
    },
  )

  it('allows a genuinely empty loaded chat to use the new-chat layout', () => {
    expect(
      conversationPhase({
        composer: 'blank',
        child: false,
        tab: 'chat',
        historyState: 'open',
      }),
    ).toBe('hero')
  })

  it('shows the hero only for a blank or engaging top-level chat', () => {
    const base = {
      composer: 'blank' as const,
      child: false,
      tab: 'chat' as const,
    }
    expect(conversationPhase(base)).toBe('hero')
    expect(conversationPhase({ ...base, composer: 'engaging' })).toBe('hero')
    expect(conversationPhase({ ...base, composer: 'active' })).toBe('active')
    expect(conversationPhase({ ...base, child: true })).toBe('active')
    expect(conversationPhase({ ...base, tab: 'trajectory' })).toBe('active')
  })

  it('detects child sessions by lineage depth', () => {
    expect(isChildLineage(null)).toBe(false)
    expect(isChildLineage({ chain: [{ sessionId: 'root' }] })).toBe(false)
    expect(
      isChildLineage({ chain: [{ sessionId: 'root' }, { sessionId: 'kid' }] }),
    ).toBe(true)
  })

  it('builds project / title crumbs for top-level sessions', () => {
    const crumbs = conversationCrumbs({
      sessionId: 's1',
      session: session({
        mode: 'build',
        project_name: 'emperor',
        project_id: 'p1',
      }),
      lineage: null,
      titleOf: () => undefined,
    })
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      'emperor',
      '重构设置页',
    ])
    expect(crumbs.at(-1)?.current).toBe(true)
  })

  it('builds navigable ancestor crumbs for child sessions', () => {
    const crumbs = conversationCrumbs({
      sessionId: 'kid2',
      session: undefined,
      lineage: {
        chain: [
          { sessionId: 'root' },
          { sessionId: 'kid1', description: '调研 API' },
          { sessionId: 'kid2', description: '读取文档' },
        ],
      },
      titleOf: (id) => (id === 'root' ? '根会话' : undefined),
    })
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      '根会话',
      '调研 API',
      '读取文档',
    ])
    expect(crumbs[0]!.sessionId).toBe('root')
    expect(crumbs[1]!.subagent).toBe(true)
    expect(crumbs[1]!.nativeSessionId).toBe('kid1')
    expect(crumbs[2]!.nativeSessionId).toBe('kid2')
    expect(crumbs[2]!.current).toBe(true)
    expect(crumbs[2]!.source).toBeUndefined()
  })
})
it('keeps retained external task controls reachable even when the visible chat transcript is empty', () => {
  expect(
    conversationPhase({
      composer: 'blank',
      child: false,
      tab: 'chat',
      externalActivity: true,
    }),
  ).toBe('active')
})

it('uses the canonical Emperor fallback when a child creation description is absent', () => {
  expect(
    conversationCrumbs({
      sessionId: 'sub-child',
      session: undefined,
      lineage: { chain: [{ sessionId: 'root' }, { sessionId: 'sub-child' }] },
      titleOf: () => 'generated title',
    }).at(-1)?.label,
  ).toBe('本地子智能体')
})

describe('sessionRunning: one source for the composer and the turn status (FIX-03 7)', () => {
  it('follows the raw log projection once the window is open', () => {
    expect(
      sessionRunning({
        windowOpen: true,
        logRunning: true,
        active: true,
        runtimeBusy: false,
      }),
    ).toBe(true)
    // A stale runtime busy never keeps the stop button on.
    expect(
      sessionRunning({
        windowOpen: true,
        logRunning: false,
        active: true,
        runtimeBusy: true,
      }),
    ).toBe(false)
  })

  it('uses the runtime busy of the active session until the window opens', () => {
    expect(
      sessionRunning({
        windowOpen: false,
        logRunning: false,
        active: true,
        runtimeBusy: true,
      }),
    ).toBe(true)
    expect(
      sessionRunning({
        windowOpen: false,
        logRunning: false,
        active: false,
        runtimeBusy: true,
      }),
    ).toBe(false)
  })
})
