import { describe, expect, it, vi } from 'vitest'
import { OPEN_PATH_CHANNEL } from '../shared/ipc-contract'
import {
  parseOpenPathTarget,
  registerOpenPathIpc,
  type OpenPathSources,
} from './open-path-ipc'

const sources: OpenPathSources = {
  emperorHome: () => '/Users/me/.emperor',
  activeProject: () => '/Users/me/code/app',
  skillFolder: (name, sessionId) =>
    name === 'review' && sessionId === 's1'
      ? '/Users/me/code/app/.emperor/skills/review'
      : null,
  invalidSkillPaths: (sessionId) =>
    sessionId === 's1'
      ? [
          '/Users/me/.emperor/skills/broken',
          '/Users/me/.emperor/skills/flat.md',
        ]
      : [],
}

function setup(overrides: Partial<OpenPathSources> = {}) {
  const handlers = new Map<
    string,
    (event: unknown, payload: unknown) => unknown
  >()
  const openPath = vi.fn(async () => '')
  const showItemInFolder = vi.fn()
  registerOpenPathIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorize: (event) => {
      if (event !== 'main') throw new Error('IPC caller is not trusted')
    },
    sources: { ...sources, ...overrides },
    isDirectory: () => true,
    openPath,
    showItemInFolder,
  })
  const invoke = async (payload: unknown, event: unknown = 'main') =>
    await handlers.get(OPEN_PATH_CHANNEL)!(event, payload)
  return { invoke, openPath, showItemInFolder }
}

describe('emperor:open-path (MAIN-27)', () => {
  it('refuses any path the renderer names, absolute or not', async () => {
    const { invoke, openPath, showItemInFolder } = setup()
    for (const payload of [
      '/Applications/Calculator.app',
      '/etc',
      '~/Downloads/run.command',
      { kind: 'path', path: '/etc' },
      { kind: 'diagnostic', rowId: 'sessions-path' },
      { kind: 'skill', name: 'review', sessionId: 'other' },
      { kind: 'invalid-skill', path: '/etc', sessionId: 's1' },
      null,
    ])
      expect(await invoke(payload)).toEqual({
        ok: false,
        error: expect.any(String),
      })
    expect(openPath).not.toHaveBeenCalled()
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('opens the folders Core vouches for', async () => {
    const { invoke, openPath } = setup()
    expect(
      await invoke({ kind: 'diagnostic', rowId: 'global-state-root' }),
    ).toEqual({ ok: true })
    await invoke({ kind: 'diagnostic', rowId: 'active-project-path' })
    await invoke({ kind: 'skill', name: 'review', sessionId: 's1' })
    await invoke({
      kind: 'invalid-skill',
      path: '/Users/me/.emperor/skills/broken',
      sessionId: 's1',
    })
    await invoke({
      kind: 'invalid-skill',
      path: '/Users/me/.emperor/skills/flat.md',
      sessionId: 's1',
    })
    expect(openPath.mock.calls).toEqual([
      ['/Users/me/.emperor'],
      ['/Users/me/code/app'],
      ['/Users/me/code/app/.emperor/skills/review'],
      ['/Users/me/.emperor/skills/broken'],
      ['/Users/me/.emperor/skills'],
    ])
  })

  it('reveals an app bundle instead of launching it', async () => {
    const { invoke, openPath, showItemInFolder } = setup({
      activeProject: () => '/Users/me/Evil.app',
    })
    expect(
      await invoke({ kind: 'diagnostic', rowId: 'active-project-path' }),
    ).toEqual({ ok: true })
    expect(openPath).not.toHaveBeenCalled()
    expect(showItemInFolder).toHaveBeenCalledWith('/Users/me/Evil.app')
  })

  it('serves the trusted main window only', async () => {
    const { invoke } = setup()
    await expect(
      invoke({ kind: 'diagnostic', rowId: 'global-state-root' }, 'pet'),
    ).rejects.toThrow(/not trusted/)
  })

  it('parses only well-formed targets', () => {
    expect(
      parseOpenPathTarget({ kind: 'skill', name: 'review', sessionId: null }),
    ).toEqual({ kind: 'skill', name: 'review', sessionId: null })
    expect(parseOpenPathTarget({ kind: 'skill', name: '' })).toBeNull()
    expect(
      parseOpenPathTarget({ kind: 'skill', name: 'x'.repeat(300) }),
    ).toBeNull()
    expect(parseOpenPathTarget('global-state-root')).toBeNull()
  })
})
