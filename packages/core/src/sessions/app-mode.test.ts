// MOD-01 (0.3, docs/design/modes.md): which mode a session is listed under
// (D2: the current project binding and `surface`, never `mode`), the
// `mode_routes` rules of the sidebar state, and the default mode.
import { describe, expect, it } from 'vitest'
import {
  APP_MODES,
  defaultAppMode,
  isAppMode,
  isKnownSessionSurface,
  isModeRouteId,
  normalizeModeRoutes,
  sessionAppMode,
} from './app-mode'

describe('sessionAppMode (MOD-01 1)', () => {
  it.each([
    ['a Chat session with no project', { mode: 'chat' }, 'chat'],
    [
      'a Chat session bound to a project',
      { mode: 'chat', project_path: '/p' },
      'build',
    ],
    ['a Build session', { mode: 'build', project_path: '/p' }, 'build'],
    [
      'a Build session whose project path is blank',
      { mode: 'build', project_path: '  ' },
      'chat',
    ],
    [
      'a Build session with no project path',
      { mode: 'build', project_path: null },
      'chat',
    ],
    ['a 1:1 contact chat', { mode: 'chat', surface: 'contact' }, 'group'],
    [
      'a group, even on a project',
      { mode: 'build', surface: 'group', project_path: '/p' },
      'group',
    ],
    ['a group member’s own session', { surface: 'group_member' }, null],
    ['a trial (试用台) session', { surface: 'trial' }, null],
    ['an unknown surface', { surface: 'workspace', project_path: '/p' }, null],
    ['an empty surface', { surface: '', mode: 'chat' }, 'chat'],
    [
      'a Build draft that has not picked its project',
      { mode: 'build', draft: true },
      'build',
    ],
    ['a Chat draft', { mode: 'chat', draft: true }, 'chat'],
  ] as const)('%s', (_label, session, expected) => {
    expect(sessionAppMode(session)).toBe(expected)
  })

  it('knows the three modes and the four surfaces only', () => {
    expect(APP_MODES).toEqual(['chat', 'build', 'group'])
    expect(APP_MODES.every(isAppMode)).toBe(true)
    for (const value of ['Chat', 'team', '', null, 1]) {
      expect(isAppMode(value)).toBe(false)
    }
    for (const value of ['contact', 'group', 'group_member', 'trial']) {
      expect(isKnownSessionSurface(value)).toBe(true)
    }
    expect(isKnownSessionSurface('workspace')).toBe(false)
  })
})

describe('mode_routes (MOD-01 4–5)', () => {
  it('keeps a string of at most 128 characters per known mode', () => {
    const long = 'x'.repeat(129)
    expect(
      normalizeModeRoutes({
        chat: ' s-chat ',
        build: 'x'.repeat(128),
        group: long,
        team: 's-team',
      }),
    ).toEqual({ chat: 's-chat', build: 'x'.repeat(128) })
    expect(normalizeModeRoutes({ chat: 7, build: null, group: {} })).toEqual({})
    expect(normalizeModeRoutes(['chat'])).toEqual({})
    expect(normalizeModeRoutes('chat')).toEqual({})
    expect(normalizeModeRoutes(undefined)).toEqual({})
  })

  it('never keeps a draft id', () => {
    expect(normalizeModeRoutes({ chat: 'draft:abc', build: 's-1' })).toEqual({
      build: 's-1',
    })
    expect(isModeRouteId('draft:abc')).toBe(false)
    expect(isModeRouteId('')).toBe(false)
    expect(isModeRouteId('s-1')).toBe(true)
  })
})

describe('defaultAppMode (MOD-01 3)', () => {
  it('takes the mode of the first listed session (lists put the most recent first)', () => {
    expect(
      defaultAppMode([
        { mode: 'chat', archived_at: '2026-10-27T00:00:00+0800' },
        { surface: 'group_member' },
        { mode: 'build', project_path: '/p' },
        { mode: 'chat' },
      ]),
    ).toBe('build')
    expect(defaultAppMode([{ surface: 'group' }, { mode: 'chat' }])).toBe(
      'group',
    )
  })

  it('is Chat without any listed session', () => {
    expect(defaultAppMode([])).toBe('chat')
    expect(defaultAppMode([{ surface: 'trial' }])).toBe('chat')
  })
})
