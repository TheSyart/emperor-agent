/**
 * Right workspace pane catalogue (launcher rows, header segmented control):
 * label, shortcut action and the availability rule of each pane. Pure.
 */
import type { WorkspacePane } from '../shell/frameState'
import type { ShortcutAction } from '../../shortcuts'

export type WorkspaceContentPane = Exclude<WorkspacePane, 'launcher'>

export interface WorkspacePaneItem {
  pane: WorkspaceContentPane
  label: string
  shortcut: ShortcutAction
}

export const WORKSPACE_PANE_ITEMS: readonly WorkspacePaneItem[] = [
  { pane: 'review', label: '审查', shortcut: 'workspace.review' },
  { pane: 'terminal', label: '终端', shortcut: 'workspace.terminal' },
  { pane: 'files', label: '文件', shortcut: 'workspace.files' },
  { pane: 'browser', label: '浏览器', shortcut: 'workspace.browser' },
  { pane: 'desktop', label: '电脑', shortcut: 'workspace.desktop' },
]

export interface WorkspaceAvailability {
  /** A persisted Build session bound to a project. */
  hasProject: boolean
  /** A snapshot has loaded (git presence is unknown before). */
  snapshotLoaded: boolean
  hasGit: boolean
}

export const NO_PROJECT_REASON = '当前会话未绑定项目'
export const NO_GIT_REASON = '当前项目未初始化 Git'

/** Why `pane` is unavailable, or '' when it can open. */
export function workspacePaneDisabledReason(
  pane: WorkspaceContentPane,
  availability: WorkspaceAvailability,
): string {
  if (pane === 'browser' || pane === 'desktop') return ''
  if (!availability.hasProject) return NO_PROJECT_REASON
  // Unknown until the first snapshot lands: keep review reachable meanwhile.
  if (pane === 'review' && availability.snapshotLoaded && !availability.hasGit)
    return NO_GIT_REASON
  return ''
}

export function workspacePaneTitle(pane: WorkspacePane): string {
  return (
    WORKSPACE_PANE_ITEMS.find((item) => item.pane === pane)?.label ?? '工作台'
  )
}
