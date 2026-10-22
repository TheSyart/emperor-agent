import { describe, expect, it } from 'vitest'
import {
  RECOVERED_REVERT_NOTE,
  fileCounts,
  fileStatusTag,
  revertSkipLabel,
  revertSummary,
  splitFilePath,
  TASK_SCOPE_LABEL,
  turnFilesCaption,
  turnFilesScope,
  turnFilesSkippedText,
  turnRevertCopy,
  turnReviewTitle,
} from './turnFilesModel'

describe('turn files card model', () => {
  it('splits a path into a dim folder and a bright name', () => {
    expect(splitFilePath('src/components/Login.vue')).toEqual({
      dir: 'src/components/',
      name: 'Login.vue',
    })
    expect(splitFilePath('README.md')).toEqual({ dir: '', name: 'README.md' })
  })

  it('says how a file changed', () => {
    const base = { path: 'a.ts', additions: 3, deletions: 1 }
    expect(fileCounts({ ...base, status: 'modified' })).toEqual({
      additions: '+3',
      deletions: '−1',
    })
    expect(fileCounts({ ...base, status: 'added', deletions: 0 })).toEqual({
      additions: '+3',
      deletions: '',
    })
    expect(
      fileCounts({
        ...base,
        status: 'added',
        additions: null,
        deletions: null,
        binary: true,
      }),
    ).toEqual({ note: '二进制' })
    expect(
      fileCounts({
        ...base,
        status: 'added',
        additions: null,
        deletions: null,
        tooLarge: true,
      }),
    ).toEqual({ note: '过大，未记录内容' })
    expect(fileStatusTag({ ...base, status: 'added' })).toBe('新建')
    expect(fileStatusTag({ ...base, status: 'deleted' })).toBe('删除')
    expect(fileStatusTag({ ...base, status: 'renamed', oldPath: 'b.ts' })).toBe(
      '由 b.ts 重命名',
    )
    expect(fileStatusTag({ ...base, status: 'modified' })).toBeNull()
  })

  it('explains unrecorded turns, the comparison and undo results', () => {
    expect(turnFilesSkippedText('timeout')).toBe(
      '本轮改动未记录：项目快照超过 5 秒',
    )
    expect(turnFilesSkippedText('git-error')).toBe('本轮改动未记录：Git 出错')
    expect(turnFilesCaption({ mode: 'git', truncated: false })).toBe(
      '按本轮开始与结束时的项目对比',
    )
    expect(turnFilesCaption({ mode: 'tools', truncated: true })).toBe(
      '只统计 Emperor 文件工具写入的文件 · 只列出前 200 个',
    )
    expect(revertSummary({ reverted: ['a'], skipped: [] })).toBe('已撤销')
    expect(
      revertSummary({
        reverted: ['a'],
        skipped: [{ path: 'b', reason: 'changed-since' }],
      }),
    ).toBe('已撤销，跳过 1 个')
    expect(revertSkipLabel('changed-since')).toBe('之后又改过，已跳过')
    expect(revertSkipLabel('missing')).toBe('快照已清理，已跳过')
    expect(revertSkipLabel('error')).toBe('无法恢复，已跳过')
  })

  it('speaks of the task for a task’s record, of the turn for an older one (UI-S15)', () => {
    const task = { firstTurn: 1, lastTurn: 3 }
    expect(turnFilesScope({ task })).toBe('task')
    expect(turnFilesScope({})).toBe('turn')
    expect(TASK_SCOPE_LABEL).toBe('这次任务')
    expect(turnFilesCaption({ mode: 'git', truncated: false, task })).toBe(
      '按这次任务开始与结束时的项目对比',
    )
    expect(turnFilesCaption({ mode: 'tools', truncated: false, task })).toBe(
      '只统计 Emperor 文件工具写入的文件',
    )
    expect(turnFilesSkippedText('timeout', 'task')).toBe(
      '这次任务的改动未记录：项目快照超过 5 秒',
    )
    expect(turnFilesSkippedText('git-error', 'task')).toBe(
      '这次任务的改动未记录：Git 出错',
    )
    expect(turnRevertCopy('task')).toEqual({
      title: '撤销这次任务的改动？',
      description:
        '只恢复这次任务结束后没有再改过的文件，改过的会跳过并列出。撤销后不能重做。',
      concurrent:
        '这次任务期间，同一工作区还有其他会话在运行，列表里可能有它们的改动。',
    })
    expect(turnRevertCopy('turn')).toEqual({
      title: '撤销这一轮的改动？',
      description:
        '只恢复这一轮结束后没有再改过的文件，改过的会跳过并列出。撤销后不能重做。',
      concurrent:
        '这一轮期间，同一工作区还有其他会话在运行，列表里可能有它们的改动。',
    })
    expect(turnReviewTitle('task')).toBe('这次任务的改动')
    expect(turnReviewTitle('turn')).toBe('本轮改动')
  })

  it('says when a task was recorded only after Emperor came back', () => {
    const task = { firstTurn: 2, lastTurn: 4 }
    expect(
      turnFilesCaption({
        mode: 'git',
        truncated: false,
        task,
        recovered: true,
      }),
    ).toBe(
      '按这次任务开始与重新打开 Emperor 时的项目对比（任务中途 Emperor 退出过，这段时间在 Emperor 之外的改动也算在内）',
    )
    expect(RECOVERED_REVERT_NOTE).toBe(
      '这次任务进行中 Emperor 退出过，列表按重新打开时的项目对比，可能含有在 Emperor 之外做的改动。',
    )
  })
})
