import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, SessionInfo } from '../types'
import {
  APP_MODES,
  currentBuildProject,
  modeActivity,
  modeLandingSessionId,
  modeSwitchTarget,
  nextListedSession,
  rememberModeRoute,
  routeModeTarget,
  sessionAppMode,
  sessionsInMode,
  waitingElsewhere,
} from './appMode'

// MOD-01 (0.3, docs/design/modes.md): the mode a session is listed under,
// the mode of the route on screen, and where switching to a mode goes.

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: overrides.id || 's',
    title: overrides.title || 'Untitled',
    created_at: '2026-10-27T00:00:00+0800',
    updated_at: '2026-10-27T00:00:00+0800',
    preview: '',
    mode: 'chat',
    version: 1,
    ...overrides,
  }
}

const chat = session({ id: 'chat-1' })
const build = session({
  id: 'build-1',
  mode: 'build',
  project_id: 'p1',
  project_path: '/tmp/alpha',
  project_name: 'Alpha',
})
const group = session({ id: 'group-1', surface: 'group', group_id: 'grp-1' })
const contact = session({
  id: 'contact-1',
  surface: 'contact',
  contact_id: 'ct-codex',
})
const member = session({ id: 'member-1', surface: 'group_member' })
const trial = session({ id: 'trial-1', surface: 'trial' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sessionAppMode (MOD-01 1)', () => {
  it.each([
    ['a Chat session with no project', chat, 'chat'],
    [
      'a Chat session bound to a project',
      session({ project_path: '/tmp/alpha' }),
      'build',
    ],
    ['a Build session', build, 'build'],
    [
      'a project path of blanks only',
      session({ mode: 'build', project_path: '   ' }),
      'chat',
    ],
    ['a contact chat', contact, 'group'],
    ['a group', group, 'group'],
    ['a group member’s session', member, null],
    ['a trial session', trial, null],
    [
      'a Build draft without its project yet (the Build home)',
      session({ id: 'draft:b', mode: 'build', draft: true }),
      'build',
    ],
  ] as const)('%s', (_label, item, expected) => {
    expect(sessionAppMode(item)).toBe(expected)
  })

  it('lists an unknown surface nowhere and says so once in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const future = session({
      id: 'future-1',
      surface: 'workspace' as SessionInfo['surface'],
      project_path: '/tmp/alpha',
    })
    expect(sessionAppMode(future)).toBeNull()
    expect(sessionAppMode(future)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('workspace')
  })

  it('has three modes in menu order', () => {
    expect(APP_MODES).toEqual(['chat', 'build', 'group'])
  })
})

describe('binding follows the project (MOD-01 2, D2)', () => {
  it('moves a Chat session to Build when it gets a project and back when it loses it', () => {
    const live = session({ id: 'chat-2' })
    const list = [live, build]
    expect(sessionsInMode(list, 'chat').map((item) => item.id)).toEqual([
      'chat-2',
    ])
    live.project_path = '/tmp/alpha'
    expect(sessionsInMode(list, 'chat')).toEqual([])
    expect(sessionsInMode(list, 'build').map((item) => item.id)).toEqual([
      'chat-2',
      'build-1',
    ])
    // The session's own `mode` never changes (D2).
    expect(live.mode).toBe('chat')
    live.project_path = null
    expect(sessionsInMode(list, 'chat').map((item) => item.id)).toEqual([
      'chat-2',
    ])
  })

  it('never lists drafts, archived, member or trial sessions in a mode', () => {
    const list = [
      session({ id: 'draft:x', draft: true }),
      session({ id: 'old', archived_at: '2026-10-01T00:00:00+0800' }),
      member,
      trial,
      group,
      contact,
    ]
    expect(sessionsInMode(list, 'chat')).toEqual([])
    expect(sessionsInMode(list, 'group').map((item) => item.id)).toEqual([
      'group-1',
      'contact-1',
    ])
  })
})

describe('routeModeTarget (MOD-01 8–9)', () => {
  const find = (id: string) =>
    [chat, build, group, member].find((item) => item.id === id)

  it('takes the mode of the session on a conversation route', () => {
    expect(
      routeModeTarget({ name: 'chat', params: { sessionId: 'group-1' } }, find),
    ).toEqual({ mode: 'group', sessionId: 'group-1' })
    expect(
      routeModeTarget(
        { name: 'trajectory', params: { sessionId: 'build-1' } },
        find,
      ),
    ).toEqual({ mode: 'build', sessionId: 'build-1' })
    expect(
      routeModeTarget(
        {
          name: 'external-agent',
          params: { sessionId: 'chat-1', delegationId: 'dlg-1' },
        },
        find,
      ),
    ).toEqual({ mode: 'chat', sessionId: 'chat-1' })
  })

  it('has no mode on pages, unknown sessions and member sessions', () => {
    for (const name of ['scheduler', 'capabilities', 'pulls', 'github-ci'])
      expect(routeModeTarget({ name, params: {} }, find).mode).toBeNull()
    expect(
      routeModeTarget({ name: 'chat', params: { sessionId: 'child' } }, find)
        .mode,
    ).toBeNull()
    expect(
      routeModeTarget({ name: 'chat', params: { sessionId: 'member-1' } }, find)
        .mode,
    ).toBeNull()
    expect(routeModeTarget({ name: 'chat', params: {} }, find).mode).toBeNull()
  })

  it('puts the Group home (contacts) in Group', () => {
    expect(routeModeTarget({ name: 'contacts', params: {} }, find)).toEqual({
      mode: 'group',
      sessionId: '',
    })
  })

  it('puts the contact editor in Group (GRP-04)', () => {
    expect(routeModeTarget({ name: 'contact-new', params: {} }, find)).toEqual({
      mode: 'group',
      sessionId: '',
    })
    expect(
      routeModeTarget(
        { name: 'contact-edit', params: { id: 'ct-reviewer00001' } },
        find,
      ),
    ).toEqual({ mode: 'group', sessionId: '' })
  })
})

describe('mode_routes (MOD-01 5)', () => {
  it('remembers a real session and never a draft', () => {
    const routes = rememberModeRoute({}, 'chat', 'chat-1')
    expect(routes).toEqual({ chat: 'chat-1' })
    expect(rememberModeRoute(routes, 'chat', 'draft:abc')).toBe(routes)
    expect(rememberModeRoute(routes, 'chat', 'chat-1')).toBe(routes)
    expect(rememberModeRoute(routes, 'build', 'x'.repeat(129))).toBe(routes)
    expect(rememberModeRoute(routes, 'build', 'build-1')).toEqual({
      chat: 'chat-1',
      build: 'build-1',
    })
  })
})

describe('switching and landing (MOD-01 6–7, 10)', () => {
  const list = [chat, build, group]

  it('goes back to the last session of the mode while it is still there', () => {
    expect(modeSwitchTarget('build', { build: 'build-1' }, list)).toEqual({
      kind: 'session',
      id: 'build-1',
    })
  })

  it('goes to the mode’s home when the last session is gone or moved', () => {
    expect(modeSwitchTarget('build', { build: 'deleted' }, list)).toEqual({
      kind: 'home',
    })
    // A remembered session that lost its project is a Chat now.
    expect(modeSwitchTarget('build', { build: 'chat-1' }, list)).toEqual({
      kind: 'home',
    })
    expect(modeSwitchTarget('chat', {}, list)).toEqual({ kind: 'home' })
  })

  it('lands at start-up in the saved mode, keeping the open session when it fits', () => {
    // The most recent session (active) is in the saved mode: keep it.
    expect(modeLandingSessionId('chat', {}, list, 'chat-1')).toBe('chat-1')
    // It is not: the mode's last session, else its most recent one.
    expect(
      modeLandingSessionId('build', { build: 'build-1' }, list, 'chat-1'),
    ).toBe('build-1')
    expect(modeLandingSessionId('build', {}, list, 'chat-1')).toBe('build-1')
    expect(modeLandingSessionId('group', {}, list, 'chat-1')).toBe('group-1')
    // Nothing in the mode: its home.
    expect(modeLandingSessionId('build', {}, [chat], 'chat-1')).toBeNull()
    // The draft an empty list starts with stays when it fits the mode.
    const draft = session({ id: 'draft:first', draft: true })
    expect(modeLandingSessionId('chat', {}, [draft], 'draft:first')).toBe(
      'draft:first',
    )
    expect(modeLandingSessionId('build', {}, [draft], 'draft:first')).toBeNull()
  })
})

describe('currentBuildProject (⌘N in Build)', () => {
  const projects: ProjectInfo[] = [
    {
      project_id: 'p-old',
      project_path: '/tmp/old',
      project_name: 'Old',
      updated_at: '2026-10-01T00:00:00+0800',
    },
    {
      project_id: 'p-new',
      project_path: '/tmp/new',
      project_name: 'New',
      updated_at: '2026-10-26T00:00:00+0800',
    },
  ]

  it('takes the open Build session’s project first', () => {
    expect(
      currentBuildProject({ current: build, projects })?.project_path,
    ).toBe('/tmp/alpha')
  })

  it('then the last Build session’s, then the most recent project', () => {
    expect(
      currentBuildProject({ current: chat, remembered: build, projects })
        ?.project_id,
    ).toBe('p1')
    expect(currentBuildProject({ current: chat, projects })?.project_id).toBe(
      'p-new',
    )
    expect(currentBuildProject({ current: chat, projects: [] })).toBeNull()
  })
})

// MOD-02 (docs/design/modes.md § 侧栏): what the switcher shows for each
// mode, and where the window goes when the open session goes away.

describe('mode activity for the switcher (MOD-02 5–6)', () => {
  const chat2 = session({ id: 'chat-2' })
  const build2 = session({
    id: 'build-2',
    mode: 'build',
    project_path: '/tmp/alpha',
  })
  const sessions = [chat, chat2, build, build2, group, contact, member, trial]

  it('counts running sessions and notes a waiting one per mode', () => {
    const running = new Set(['build-1', 'build-2', 'member-1', 'chat-2'])
    const waiting = new Set(['contact-1', 'trial-1'])
    expect(
      modeActivity(sessions, {
        running: (id) => running.has(id),
        waiting: (item) => waiting.has(item.id),
      }),
    ).toEqual({
      chat: { running: 1, waiting: false },
      build: { running: 2, waiting: false },
      // A member's or a trial session is listed nowhere and counts nowhere.
      group: { running: 0, waiting: true },
    })
  })

  it('never counts drafts or archived sessions', () => {
    const draft = session({ id: 'draft:1', draft: true })
    const archived = session({ id: 'old', archived_at: '2026-10-01' })
    expect(
      modeActivity([draft, archived], {
        running: () => true,
        waiting: () => true,
      }).chat,
    ).toEqual({ running: 0, waiting: false })
  })

  it('lights the mark only for a waiting mode other than the current one', () => {
    const idle = { running: 0, waiting: false }
    const busy = { running: 3, waiting: false }
    const asks = { running: 0, waiting: true }
    expect(
      waitingElsewhere({ chat: idle, build: busy, group: idle }, 'chat'),
    ).toBe(false)
    expect(
      waitingElsewhere({ chat: idle, build: idle, group: asks }, 'chat'),
    ).toBe(true)
    expect(
      waitingElsewhere({ chat: idle, build: idle, group: asks }, 'group'),
    ).toBe(false)
  })
})

describe('the next session when one goes away (MOD-02)', () => {
  const older = session({ id: 'chat-old' })
  const list = [member, build, chat, older, trial]

  it('prefers a listed session of the mode and skips unlisted ones', () => {
    expect(nextListedSession(list, { mode: 'chat' })?.id).toBe('chat-1')
    expect(
      nextListedSession(list, { mode: 'chat', exclude: 'chat-1' })?.id,
    ).toBe('chat-old')
    expect(nextListedSession(list, { mode: 'build' })?.id).toBe('build-1')
  })

  it('stays in the mode unless any mode is allowed', () => {
    expect(
      nextListedSession(list, { mode: 'build', exclude: 'build-1' }),
    ).toBeUndefined()
    expect(
      nextListedSession(list, {
        mode: 'build',
        exclude: 'build-1',
        anyMode: true,
      })?.id,
    ).toBe('chat-1')
    expect(
      nextListedSession([member, trial], { mode: 'chat', anyMode: true }),
    ).toBeUndefined()
  })
})
