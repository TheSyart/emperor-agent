import type {
  GitOperationAction,
  GitOperationCompletedEvent,
  WsEvent,
} from '../../types'

/**
 * `git_operation_completed` (host-only receipt of a workspace git operation
 * in a Build session). The renderer does not project it into any view state;
 * it only becomes a notification (runtime/notifications.ts).
 */
export function isGitOperationCompletedEvent(
  event: WsEvent,
): event is WsEvent & GitOperationCompletedEvent {
  return event.event === 'git_operation_completed'
}

const GIT_OPERATION_LABELS: Record<GitOperationAction, string> = {
  commit: '已提交',
  push: '已推送',
  pull: '已拉取',
  switch_branch: '已切换分支',
  create_worktree: '已创建 worktree',
  remove_worktree: '已移除 worktree',
  publish_pr: '已发布 Pull Request',
  merge_pr: '已合并 Pull Request',
  close_pr: '已关闭 Pull Request',
}

/** Chinese one-liner of a finished git operation (「已推送 · main」). */
export function gitOperationSummary(
  event: Pick<
    GitOperationCompletedEvent,
    'action' | 'branch' | 'commitOid' | 'pullRequest'
  >,
): string {
  const label = GIT_OPERATION_LABELS[event.action] ?? 'Git 操作已完成'
  const parts = [label]
  const pr = event.pullRequest
  if (pr && Number.isFinite(pr.number) && pr.number > 0)
    parts.push(`#${pr.number}`)
  else if (event.branch) parts.push(event.branch)
  if (event.action === 'commit' && event.commitOid)
    parts.push(event.commitOid.slice(0, 7))
  return parts.join(' · ')
}
