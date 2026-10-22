/**
 * Words and shapes of the 「已编辑 N 个文件」 card (plan 7.6). Pure. A
 * record covers a task (UI-S15: a message the user sent and every turn a
 * result woke) or, in logs from before it, one turn; the words follow.
 */
import type {
  TurnFileEntry,
  TurnFilesReverted,
} from '@emperor/core/runtime-contract'

/** Rows shown before 「展开」. */
export const COLLAPSED_FILE_ROWS = 3

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

/** What a record covers: a task, or one turn (logs from before UI-S15). */
export type TurnFilesScope = 'task' | 'turn'

/** The label beside a task card's totals. */
export const TASK_SCOPE_LABEL = '这次任务'

export function turnFilesScope(data: { task?: unknown }): TurnFilesScope {
  return data.task === undefined ? 'turn' : 'task'
}

/** The card's name for screen readers and the review pane's heading. */
export function turnReviewTitle(scope: TurnFilesScope): string {
  return scope === 'task' ? '这次任务的改动' : '本轮改动'
}

export function turnFilesSkippedText(
  reason: 'timeout' | 'git-error' | undefined,
  scope: TurnFilesScope = 'turn',
): string {
  const head = scope === 'task' ? '这次任务的改动未记录' : '本轮改动未记录'
  return reason === 'timeout'
    ? `${head}：项目快照超过 5 秒`
    : `${head}：Git 出错`
}

/** The footnote: how the list was made. */
export function turnFilesCaption(data: {
  mode: 'git' | 'tools'
  truncated: boolean
  task?: unknown
  recovered?: boolean
}): string {
  const parts = [
    data.mode !== 'git'
      ? '只统计 Emperor 文件工具写入的文件'
      : data.recovered === true
        ? '按这次任务开始与重新打开 Emperor 时的项目对比（任务中途 Emperor 退出过，这段时间在 Emperor 之外的改动也算在内）'
        : turnFilesScope(data) === 'task'
          ? '按这次任务开始与结束时的项目对比'
          : '按本轮开始与结束时的项目对比',
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

/** The undo dialog's words. */
export function turnRevertCopy(scope: TurnFilesScope): {
  title: string
  description: string
  concurrent: string
} {
  const what = scope === 'task' ? '这次任务' : '这一轮'
  return {
    title: `撤销${what}的改动？`,
    description: `只恢复${what}结束后没有再改过的文件，改过的会跳过并列出。撤销后不能重做。`,
    concurrent: `${what}期间，同一工作区还有其他会话在运行，列表里可能有它们的改动。`,
  }
}

/** The undo dialog's note for a task recorded after Emperor came back. */
export const RECOVERED_REVERT_NOTE =
  '这次任务进行中 Emperor 退出过，列表按重新打开时的项目对比，可能含有在 Emperor 之外做的改动。'
