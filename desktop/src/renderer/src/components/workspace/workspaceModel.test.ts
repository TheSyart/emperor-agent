import { describe, expect, it } from 'vitest'
import {
  clampFilesTreeWidth,
  filterGitFilesByPaths,
  gitFileChangeLabel,
  gitTransientLabel,
  groupGitFiles,
} from './workspaceModel'

describe('workspace model', () => {
  it('clamps the persisted files tree size', () => {
    expect(clampFilesTreeWidth(120)).toBe(240)
    expect(clampFilesTreeWidth(999)).toBe(320)
    expect(clampFilesTreeWidth(Number.NaN)).toBe(280)
    expect(clampFilesTreeWidth(301.4)).toBe(301)
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

  it('filters Review files to exact task paths without path-prefix collisions', () => {
    const files = [
      {
        path: 'src/a.ts',
        index: 'M',
        worktree: '.',
        conflict: false,
        untracked: false,
      },
      {
        path: 'src/a.ts.bak',
        index: 'M',
        worktree: '.',
        conflict: false,
        untracked: false,
      },
      {
        path: 'src/b.ts',
        index: '.',
        worktree: 'M',
        conflict: false,
        untracked: false,
      },
    ]

    expect(
      filterGitFilesByPaths(files, ['src/a.ts']).map((file) => file.path),
    ).toEqual(['src/a.ts'])
    expect(filterGitFilesByPaths(files, [])).toEqual(files)
  })
})
