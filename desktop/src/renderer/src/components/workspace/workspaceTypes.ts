import type { GitStatusResult, WorkspaceSnapshot } from '@emperor/core'

export type { WorkspaceSnapshot }

export interface WorkspaceSource {
  id: string
  name: string
  kind: 'attachment' | 'media'
}

export function isGitStatus(
  value: WorkspaceSnapshot['git'] | null | undefined,
): value is GitStatusResult {
  return Boolean(value && typeof value.repository === 'object')
}
