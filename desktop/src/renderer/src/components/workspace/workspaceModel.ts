import type { GitFileStatus } from '@emperor/core/api'

/** Files tree column width bounds (px; right_workspace.filesTreeWidth). */
export const FILES_TREE_MIN = 240
export const FILES_TREE_MAX = 320
export const FILES_TREE_DEFAULT = 280

/** Files tree column width (px) persisted as right_workspace.filesTreeWidth. */
export function clampFilesTreeWidth(value: number): number {
  if (!Number.isFinite(value)) return FILES_TREE_DEFAULT
  return Math.max(FILES_TREE_MIN, Math.min(FILES_TREE_MAX, Math.round(value)))
}

export interface FilePathCrumb {
  name: string
  /** Project-relative path up to and including this segment. */
  path: string
}

/** Breadcrumb segments of a project-relative path (`src/a.ts` → src, a.ts). */
export function filePathCrumbs(path: string): FilePathCrumb[] {
  const parts = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.')
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join('/'),
  }))
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

export function filterGitFilesByPaths(
  files: GitFileStatus[],
  paths: string[],
): GitFileStatus[] {
  if (!paths.length) return files
  const accepted = new Set(
    paths.map((path) => path.replaceAll('\\', '/').replace(/^\.\/+/, '')),
  )
  return files.filter((file) =>
    accepted.has(file.path.replaceAll('\\', '/').replace(/^\.\/+/, '')),
  )
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
