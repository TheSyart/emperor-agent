import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../types'
import {
  conversationCrumbs,
  conversationPhase,
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
    expect(crumbs[2]!.current).toBe(true)
  })
})
