import { describe, expect, it } from 'vitest'
import {
  fileCounts,
  fileStatusTag,
  revertSkipLabel,
  revertSummary,
  splitFilePath,
  turnFilesCaption,
  turnFilesSkippedText,
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
})
