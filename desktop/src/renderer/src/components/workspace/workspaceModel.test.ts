import { describe, expect, it } from 'vitest'
import {
  availableWorkspacePanes,
  clampWorkspaceWidth,
  gitFileChangeLabel,
  gitTransientLabel,
  groupGitFiles,
  normalizeRightWorkspaceState,
  workspacePresentation,
} from './workspaceModel'

describe('right workspace model', () => {
  it('migrates missing state and clamps persisted width', () => {
    expect(normalizeRightWorkspaceState(undefined)).toEqual({
      version: 3,
      workbenchOpen: false,
      width: 840,
      filesTreeWidth: 280,
      pane: 'launcher',
    })
    expect(
      normalizeRightWorkspaceState({
        open: false,
        width: 999,
        pane: 'terminal',
      }),
    ).toEqual({
      version: 3,
      workbenchOpen: false,
      width: 960,
      filesTreeWidth: 280,
      pane: 'terminal',
    })
    expect(
      normalizeRightWorkspaceState({ open: true, pane: 'environment' }),
    ).toMatchObject({
      workbenchOpen: false,
      pane: 'launcher',
    })
    expect(
      normalizeRightWorkspaceState({
        open: true,
        width: 360,
        pane: 'files',
      }),
    ).toMatchObject({ width: 840, workbenchOpen: true, pane: 'files' })
    expect(
      normalizeRightWorkspaceState({ open: true, pane: 'files' }),
    ).toMatchObject({
      workbenchOpen: true,
      pane: 'files',
    })
    expect(
      normalizeRightWorkspaceState({
        version: 2,
        environmentOpen: false,
        workbenchOpen: true,
        pane: 'review',
      }),
    ).toMatchObject({
      version: 3,
      workbenchOpen: true,
      pane: 'review',
    })
    expect(clampWorkspaceWidth(120)).toBe(520)
  })

  it('hides project-only panes and selects responsive presentation', () => {
    expect(availableWorkspacePanes(false).map((pane) => pane.id)).toEqual([
      'review',
    ])
    expect(availableWorkspacePanes(true).map((pane) => pane.id)).toEqual([
      'review',
      'terminal',
      'files',
    ])
    expect(workspacePresentation(1300)).toBe('fixed')
    expect(workspacePresentation(900)).toBe('drawer')
    expect(workspacePresentation(700)).toBe('fullscreen')
  })

  it('projects Git files into staged, unstaged, untracked and conflict groups', () => {
    const groups = groupGitFiles([
      {
        path: 'a.ts',
        index: 'M',
        worktree: '.',
        conflict: false,
        untracked: false,
      },
      {
        path: 'b.ts',
        index: '.',
        worktree: 'M',
        conflict: false,
        untracked: false,
      },
      {
        path: 'c.ts',
        index: '?',
        worktree: '?',
        conflict: false,
        untracked: true,
      },
      {
        path: 'd.ts',
        index: 'U',
        worktree: 'U',
        conflict: true,
        untracked: false,
      },
    ])
    expect(groups.staged.map((file) => file.path)).toEqual(['a.ts'])
    expect(groups.unstaged.map((file) => file.path)).toEqual(['b.ts'])
    expect(groups.untracked.map((file) => file.path)).toEqual(['c.ts'])
    expect(groups.conflict.map((file) => file.path)).toEqual(['d.ts'])
  })

  it('renders structured Git line counts and transient repository states', () => {
    expect(
      gitFileChangeLabel({
        path: 'src/a.ts',
        index: 'M',
        worktree: '.',
        conflict: false,
        untracked: false,
        additions: 12,
        deletions: 3,
      }),
    ).toBe('+12 −3')
    expect(
      gitFileChangeLabel({
        path: 'asset.bin',
        index: '.',
        worktree: 'M',
        conflict: false,
        untracked: false,
        binary: true,
      }),
    ).toBe('binary')
    expect(gitTransientLabel('rebase')).toBe('Rebase 尚未完成')
    expect(gitTransientLabel('none')).toBe('')
  })
})
