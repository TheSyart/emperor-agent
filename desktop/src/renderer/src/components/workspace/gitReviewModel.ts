/**
 * 审查 pane model (UI-S06): the two change groups, one-letter change marks,
 * branch and sync labels, and the one-line Pull Request area. Pure.
 */
import type {
  GitFileStatus,
  GitStatusResult,
  PullRequestSummary,
} from '@emperor/core/api'
import type { ConfirmOptions } from '../ui/confirm'
import { groupGitFiles } from './workspaceModel'

export type ChangeArea = 'staged' | 'worktree'
export type ChangeTone = 'neutral' | 'ok' | 'error'

export interface ChangeStatus {
  /** One letter: M A D R C T, U (untracked), ! (conflict). */
  letter: string
  label: string
  tone: ChangeTone
}

export interface ReviewEntry {
  /** Unique across groups (a partly staged file is in both). */
  key: string
  file: GitFileStatus
  area: ChangeArea
  status: ChangeStatus
}

export interface ReviewGroup {
  id: 'staged' | 'unstaged'
  label: string
  entries: ReviewEntry[]
}

const LETTERS: Record<string, { label: string; tone: ChangeTone }> = {
  M: { label: '已修改', tone: 'neutral' },
  A: { label: '新增', tone: 'ok' },
  D: { label: '已删除', tone: 'error' },
  R: { label: '重命名', tone: 'neutral' },
  C: { label: '复制', tone: 'neutral' },
  T: { label: '类型变更', tone: 'neutral' },
}

export function changeStatus(
  file: GitFileStatus,
  area: ChangeArea,
): ChangeStatus {
  if (file.conflict) return { letter: '!', label: '冲突', tone: 'error' }
  if (file.untracked) return { letter: 'U', label: '未跟踪', tone: 'ok' }
  const letter = (area === 'staged' ? file.index : file.worktree).toUpperCase()
  const known = LETTERS[letter]
  return known ? { letter, ...known } : { letter: 'M', ...LETTERS.M! }
}

function entries(files: GitFileStatus[], area: ChangeArea, id: string) {
  return files.map((file) => ({
    key: `${id}:${file.path}`,
    file,
    area,
    status: changeStatus(file, area),
  }))
}

/**
 * 已暂存 and 未暂存. Conflicts, edits and new files all wait in 未暂存
 * (conflicts first); a group without files is left out.
 */
export function reviewGroups(files: GitFileStatus[]): ReviewGroup[] {
  const groups = groupGitFiles(files)
  return [
    {
      id: 'staged' as const,
      label: '已暂存',
      entries: entries(groups.staged, 'staged', 'staged'),
    },
    {
      id: 'unstaged' as const,
      label: '未暂存',
      entries: entries(
        [...groups.conflict, ...groups.unstaged, ...groups.untracked],
        'worktree',
        'unstaged',
      ),
    },
  ].filter((group) => group.entries.length > 0)
}

type BranchFacts = Pick<GitStatusResult, 'branch'> & {
  repository: Pick<GitStatusResult['repository'], 'unborn' | 'detached'>
}

/** The 分支名 ▾ button: the branch, or what HEAD is instead. */
export function branchLabel(status: BranchFacts | null): string {
  if (!status) return 'Git'
  if (status.branch) return status.branch
  return status.repository.unborn ? '未提交的分支' : '分离 HEAD'
}

/** Commits ahead / behind the upstream (`↑2 ↓1`), '' when in step. */
export function syncLabel(
  status: Pick<GitStatusResult, 'upstream' | 'ahead' | 'behind'> | null,
): string {
  if (!status?.upstream) return ''
  return [
    status.ahead ? `↑${status.ahead}` : '',
    status.behind ? `↓${status.behind}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** The Pull Request page route of a GitHub PR address. */
export function pullRequestRoute(
  url: string,
): { owner: string; repo: string; number: string } | null {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(url)
  return match ? { owner: match[1]!, repo: match[2]!, number: match[3]! } : null
}

/**
 * Why the current branch's PR cannot be read, in one line. Decided by the
 * error code and Core's own message (`detail`), not by the shown text,
 * which errors/messages.ts has already put into Chinese.
 */
export function pullRequestProblem(cause: unknown): string {
  const error = (cause ?? {}) as { code?: unknown; detail?: unknown }
  const shown = cause instanceof Error ? cause.message : String(cause)
  const raw = typeof error.detail === 'string' ? error.detail : shown
  if (error.code === 'git_gh_unavailable' || /git_gh_unavailable/.test(raw))
    return 'GitHub CLI 不可用，无法读取 Pull Request'
  if (/not logged|auth login|authenticat/i.test(raw))
    return 'GitHub CLI 未登录：在终端运行 gh auth login'
  return `无法读取 Pull Request：${shown.split('\n')[0]}`
}

/** A PR's state in one word. */
export function pullRequestStateLabel(pr: PullRequestSummary): string {
  const state = pr.state.toUpperCase()
  if (state === 'MERGED') return '已合并'
  if (state === 'CLOSED') return '已关闭'
  if (pr.draft) return '草稿'
  if (pr.mergeable === 'MERGEABLE') return '可合并'
  if (pr.mergeable === 'CONFLICTING') return '有冲突'
  return '打开'
}

/** What each 审查 write asks before it runs. */
export const GIT_CONFIRMS = {
  discard: (path: string): ConfirmOptions => ({
    title: `丢弃 ${path} 的未提交修改？`,
    body: '操作前会保存恢复快照。',
    confirmLabel: '丢弃',
    tone: 'danger',
  }),
  fetch: { title: '从远端获取最新引用？', confirmLabel: '获取' },
  pull: {
    title: '拉取当前分支？',
    body: '只快进，不会产生合并提交。',
    confirmLabel: '拉取',
  },
  push: { title: '推送当前分支到远端？', confirmLabel: '推送' },
  commitAndPush: {
    title: '提交并推送当前分支？',
    body: '先提交已暂存的改动，再推送到远端。',
    confirmLabel: '提交并推送',
  },
  switchBranch: (name: string): ConfirmOptions => ({
    title: `切换到分支 ${name}？`,
    confirmLabel: '切换',
  }),
  enterWorktree: {
    title: '创建并进入临时 worktree？',
    body: '新建一个分支和目录，之后的改动都在里面进行。',
    confirmLabel: '创建',
  },
  exitWorktree: {
    title: '退出当前临时 worktree？',
    body: '保留它的目录和分支。',
    confirmLabel: '退出',
  },
  removeWorktree: (path: string): ConfirmOptions => ({
    title: '删除这个 worktree？',
    body: `删除 Emperor 创建的 worktree ${path}。存在修改或未推送提交时会拒绝。`,
    confirmLabel: '删除',
    tone: 'danger',
  }),
} satisfies Record<string, ConfirmOptions | ((value: string) => ConfirmOptions)>
