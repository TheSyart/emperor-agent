/**
 * Words and shapes of the 「已编辑 N 个文件」 card (plan 7.6). Pure.
 */
import type {
  TurnFileEntry,
  TurnFilesReverted,
} from '@emperor/core/runtime-contract'

/** Rows shown before 「展开」. */
export const COLLAPSED_FILE_ROWS = 5

export function splitFilePath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

export function fileCounts(
  file: TurnFileEntry,
): { additions: string; deletions: string } | { note: string } {
  if (file.tooLarge) return { note: '过大，未记录内容' }
  if (file.binary || file.additions === null || file.deletions === null)
    return { note: '二进制' }
  // A side that did not change stays empty (a new file shows only `+N`).
  return {
    additions: file.additions === 0 ? '' : `+${file.additions}`,
    deletions: file.deletions === 0 ? '' : `−${file.deletions}`,
  }
}

export function fileStatusTag(file: TurnFileEntry): string | null {
  switch (file.status) {
    case 'added':
      return '新建'
    case 'deleted':
      return '删除'
    case 'renamed':
      return file.oldPath === undefined ? '重命名' : `由 ${file.oldPath} 重命名`
    default:
      return null
  }
}

export function turnFilesSkippedText(
  reason: 'timeout' | 'git-error' | undefined,
): string {
  return reason === 'timeout'
    ? '本轮改动未记录：项目快照超过 5 秒'
    : '本轮改动未记录：Git 出错'
}

/** The footnote: how the list was made. */
export function turnFilesCaption(data: {
  mode: 'git' | 'tools'
  truncated: boolean
}): string {
  const parts = [
    data.mode === 'git'
      ? '按本轮开始与结束时的项目对比'
      : '只统计 Emperor 文件工具写入的文件',
  ]
  if (data.truncated) parts.push('只列出前 200 个')
  return parts.join(' · ')
}

export function revertSummary(reverted: {
  readonly reverted: readonly string[]
  readonly skipped: readonly unknown[]
}): string {
  return reverted.skipped.length === 0
    ? '已撤销'
    : `已撤销，跳过 ${reverted.skipped.length} 个`
}

export function revertSkipLabel(
  reason: TurnFilesReverted['skipped'][number]['reason'],
): string {
  switch (reason) {
    case 'changed-since':
      return '之后又改过，已跳过'
    case 'missing':
      return '快照已清理，已跳过'
    default:
      return '无法恢复，已跳过'
  }
}
