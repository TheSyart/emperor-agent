import type { GitFileStatus } from '@emperor/core'

export type WorkspacePaneId = 'launcher' | 'review' | 'terminal' | 'files'
export type WorkspacePresentation = 'fixed' | 'drawer' | 'fullscreen'

export interface RightWorkspaceState {
  version: 3
  workbenchOpen: boolean
  width: number
  filesTreeWidth: number
  pane: WorkspacePaneId
}

type LegacyRightWorkspaceState = {
  version?: number
  open?: boolean
  environmentOpen?: boolean
  workbenchOpen?: boolean
  filesTreeWidth?: number
  width?: number
  pane?: WorkspacePaneId | 'environment'
}

export interface WorkspacePaneOption {
  id: WorkspacePaneId
  label: string
  projectOnly: boolean
}

const PANES: WorkspacePaneOption[] = [
  { id: 'review', label: 'Review', projectOnly: false },
  { id: 'terminal', label: 'Terminal', projectOnly: true },
  { id: 'files', label: 'Files', projectOnly: true },
]

export const DEFAULT_WORKSPACE_WIDTH = 840

export function clampWorkspaceWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WORKSPACE_WIDTH
  return Math.max(520, Math.min(960, Math.round(value)))
}

export function clampFilesTreeWidth(value: number): number {
  if (!Number.isFinite(value)) return 280
  return Math.max(240, Math.min(320, Math.round(value)))
}

export function normalizeRightWorkspaceState(
  value:
    Partial<RightWorkspaceState> | LegacyRightWorkspaceState | null | undefined,
): RightWorkspaceState {
  const raw = (value || {}) as Partial<RightWorkspaceState> &
    LegacyRightWorkspaceState
  if (raw.version === 3) {
    const pane =
      raw.pane === 'review' || raw.pane === 'terminal' || raw.pane === 'files'
        ? raw.pane
        : 'launcher'
    return {
      version: 3,
      workbenchOpen: raw.workbenchOpen === true,
      width: clampWorkspaceWidth(Number(raw.width ?? DEFAULT_WORKSPACE_WIDTH)),
      filesTreeWidth: clampFilesTreeWidth(Number(raw.filesTreeWidth ?? 280)),
      pane,
    }
  }
  if (raw.version === 2) {
    const pane =
      raw.pane === 'review' || raw.pane === 'terminal' || raw.pane === 'files'
        ? raw.pane
        : 'launcher'
    return {
      version: 3,
      workbenchOpen: raw.workbenchOpen === true,
      width: clampWorkspaceWidth(Number(raw.width ?? DEFAULT_WORKSPACE_WIDTH)),
      filesTreeWidth: clampFilesTreeWidth(Number(raw.filesTreeWidth ?? 280)),
      pane,
    }
  }
  const legacyPane = raw.pane
  const legacyOpen = raw.open === undefined ? true : raw.open === true
  const pane =
    legacyPane === 'review' ||
    legacyPane === 'terminal' ||
    legacyPane === 'files'
      ? legacyPane
      : 'launcher'
  const legacyWidth = Number(raw.width)
  return {
    version: 3,
    workbenchOpen: legacyOpen && pane !== 'launcher',
    width:
      Number.isFinite(legacyWidth) && legacyWidth >= 520
        ? clampWorkspaceWidth(legacyWidth)
        : DEFAULT_WORKSPACE_WIDTH,
    filesTreeWidth: 280,
    pane,
  }
}

export function availableWorkspacePanes(
  hasProject: boolean,
): WorkspacePaneOption[] {
  return PANES.filter((pane) => hasProject || !pane.projectOnly)
}

export function workspacePresentation(width: number): WorkspacePresentation {
  if (width >= 1180) return 'fixed'
  if (width >= 820) return 'drawer'
  return 'fullscreen'
}

export function groupGitFiles(files: GitFileStatus[]): {
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  untracked: GitFileStatus[]
  conflict: GitFileStatus[]
} {
  const conflict = files.filter((file) => file.conflict)
  const ordinary = files.filter((file) => !file.conflict)
  return {
    staged: ordinary.filter(
      (file) => !file.untracked && file.index !== '.' && file.index !== ' ',
    ),
    unstaged: ordinary.filter(
      (file) =>
        !file.untracked && file.worktree !== '.' && file.worktree !== ' ',
    ),
    untracked: ordinary.filter((file) => file.untracked),
    conflict,
  }
}

export function gitFileChangeLabel(file: GitFileStatus): string {
  if (file.binary) return 'binary'
  const additions = Math.max(0, Math.floor(file.additions ?? 0))
  const deletions = Math.max(0, Math.floor(file.deletions ?? 0))
  if (!additions && !deletions) return ''
  return `+${additions} −${deletions}`
}

export function gitTransientLabel(
  state: 'none' | 'merge' | 'rebase' | 'cherry_pick' | 'revert' | 'bisect',
): string {
  return (
    {
      none: '',
      merge: 'Merge 尚未完成',
      rebase: 'Rebase 尚未完成',
      cherry_pick: 'Cherry-pick 尚未完成',
      revert: 'Revert 尚未完成',
      bisect: 'Bisect 正在进行',
    } as const
  )[state]
}
