import { describe, expect, it } from 'vitest'
import type { GitFileStatus } from '@emperor/core/api'
import {
  branchLabel,
  changeStatus,
  pullRequestProblem,
  pullRequestRoute,
  pullRequestStateLabel,
  reviewGroups,
  syncLabel,
} from './gitReviewModel'

function file(
  path: string,
  index: string,
  worktree: string,
  extra: Partial<GitFileStatus> = {},
): GitFileStatus {
  return {
    path,
    index,
    worktree,
    conflict: false,
    untracked: false,
    ...extra,
  }
}

describe('git review model (UI-S06)', () => {
  it('groups changes into 已暂存 and 未暂存 and drops an empty group', () => {
    expect(reviewGroups([])).toEqual([])
    const onlyWorktree = reviewGroups([file('README.md', '.', 'M')])
    expect(onlyWorktree.map((group) => group.id)).toEqual(['unstaged'])
    expect(onlyWorktree[0]!.label).toBe('未暂存')

    const both = reviewGroups([
      file('src/a.ts', 'M', '.'),
      file('src/b.ts', 'M', 'M'),
      file('notes.md', '?', '?', { untracked: true }),
      file('merge.ts', 'U', 'U', { conflict: true }),
    ])
    expect(both.map((group) => [group.id, group.label])).toEqual([
      ['staged', '已暂存'],
      ['unstaged', '未暂存'],
    ])
    expect(both[0]!.entries.map((entry) => entry.file.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    // Conflicts first, then edits, then new files; a partly staged file is
    // in both groups.
    expect(both[1]!.entries.map((entry) => entry.file.path)).toEqual([
      'merge.ts',
      'src/b.ts',
      'notes.md',
    ])
    expect(both[0]!.entries[0]!.area).toBe('staged')
    expect(both[1]!.entries[0]!.area).toBe('worktree')
    expect(new Set(both.flatMap((g) => g.entries.map((e) => e.key))).size).toBe(
      5,
    )
  })

  it('names each change with one letter and a Chinese label', () => {
    expect(changeStatus(file('a', 'M', '.'), 'staged')).toEqual({
      letter: 'M',
      label: '已修改',
      tone: 'neutral',
    })
    expect(changeStatus(file('a', 'A', '.'), 'staged').label).toBe('新增')
    expect(changeStatus(file('a', '.', 'D'), 'worktree')).toMatchObject({
      letter: 'D',
      label: '已删除',
      tone: 'error',
    })
    expect(
      changeStatus(file('a', '?', '?', { untracked: true }), 'worktree'),
    ).toEqual({ letter: 'U', label: '未跟踪', tone: 'ok' })
    expect(
      changeStatus(file('a', 'U', 'U', { conflict: true }), 'worktree'),
    ).toMatchObject({ letter: '!', label: '冲突', tone: 'error' })
    expect(changeStatus(file('b', 'R', '.'), 'staged').label).toBe('重命名')
  })

  it('labels the branch, an unborn branch and a detached HEAD', () => {
    const base = {
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      repository: { unborn: false, detached: false },
    }
    expect(branchLabel(base)).toBe('main')
    expect(
      branchLabel({
        ...base,
        branch: null,
        repository: { unborn: false, detached: true },
      }),
    ).toBe('分离 HEAD')
    expect(
      branchLabel({
        ...base,
        branch: null,
        repository: { unborn: true, detached: false },
      }),
    ).toBe('未提交的分支')
    expect(branchLabel(null)).toBe('Git')
    expect(syncLabel(base)).toBe('↑2 ↓1')
    expect(syncLabel({ ...base, ahead: 0, behind: 0 })).toBe('')
    expect(syncLabel({ ...base, upstream: null })).toBe('')
  })

  it('reads the Pull Request page route from a GitHub PR address', () => {
    expect(pullRequestRoute('https://github.com/acme/demo/pull/42')).toEqual({
      owner: 'acme',
      repo: 'demo',
      number: '42',
    })
    expect(
      pullRequestRoute('https://github.com/acme/demo.js/pull/7/files'),
    ).toEqual({ owner: 'acme', repo: 'demo.js', number: '7' })
    expect(
      pullRequestRoute('https://gitlab.com/acme/demo/-/merge_requests/3'),
    ).toBe(null)
    expect(pullRequestRoute('not a url')).toBe(null)
  })

  it('says in one line why Pull Requests are unavailable', () => {
    expect(
      pullRequestProblem(
        new Error('git_gh_unavailable: GitHub CLI unavailable'),
      ),
    ).toBe('GitHub CLI 不可用，无法读取 Pull Request')
    expect(pullRequestProblem(new Error('gh: not logged in'))).toBe(
      'GitHub CLI 未登录：在终端运行 gh auth login',
    )
    expect(pullRequestProblem(new Error('boom\nstack'))).toBe(
      '无法读取 Pull Request：boom',
    )
  })

  it('states a Pull Request in Chinese', () => {
    const pr = {
      number: 1,
      url: '',
      state: 'OPEN',
      draft: false,
      mergeable: 'MERGEABLE',
      headRefName: 'a',
      baseRefName: 'main',
      checks: [],
    }
    expect(pullRequestStateLabel(pr)).toBe('可合并')
    expect(pullRequestStateLabel({ ...pr, draft: true })).toBe('草稿')
    expect(pullRequestStateLabel({ ...pr, mergeable: 'CONFLICTING' })).toBe(
      '有冲突',
    )
    expect(pullRequestStateLabel({ ...pr, mergeable: 'UNKNOWN' })).toBe('打开')
    expect(pullRequestStateLabel({ ...pr, state: 'MERGED' })).toBe('已合并')
    expect(pullRequestStateLabel({ ...pr, state: 'CLOSED' })).toBe('已关闭')
  })
})
