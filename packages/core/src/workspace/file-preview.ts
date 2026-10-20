import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { WorkspaceOperationError } from './common'
import {
  WorkspaceFilesService,
  type WorkspaceFileReadResult,
  type WorkspaceFileStat,
} from './files'

export type FilePreviewInput =
  | { source: 'project'; sessionId: string; path: string }
  | { source: 'turn'; sessionId: string; path: string; turn: number }
  | { source: 'reference'; sessionId: string; referenceId: string }
  | { source: 'attachment'; attachmentId: string }

/**
 * The previews that can change on disk (files.stat). Turn snapshots and
 * managed attachments never do.
 */
export type FileStatInput = Extract<
  FilePreviewInput,
  { source: 'project' } | { source: 'reference' }
>
export type FileStatResult = WorkspaceFileStat

export interface FilePreviewResult extends Omit<
  WorkspaceFileReadResult,
  'projectRoot' | 'relativePath' | 'kind'
> {
  /** Canonical file identity; UI owners still isolate tabs across sessions. */
  id: string
  kind: WorkspaceFileReadResult['kind'] | 'directory'
  path: string
  relativePath?: string
  extractedText?: boolean
  revealable?: boolean
}

export function filePreviewResult(
  value: WorkspaceFileReadResult,
): FilePreviewResult {
  const path = join(realpathSync(value.projectRoot), value.relativePath)
  const unsupported = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rtf)$/i.test(value.name)
  return {
    ...value,
    id: `file:${path}`,
    path,
    ...(unsupported
      ? { kind: 'binary' as const, content: undefined, truncated: false }
      : {}),
  }
}

/** Exact-path twin of previewCanonicalFile: size and mtime, no read. */
export function statCanonicalFile(path: string): FileStatResult {
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    throw new WorkspaceOperationError(
      'workspace_path_missing',
      '文件不存在或已被移除。',
    )
  }
  if (canonical !== path)
    throw new WorkspaceOperationError(
      'reference_target_changed',
      '文件位置已改变，请重新打开引用。',
    )
  const metadata = statSync(canonical)
  return {
    bytes: metadata.isFile() ? metadata.size : 0,
    modifiedAt: metadata.mtimeMs,
  }
}

/** Read a previously authorized exact file; never follow a replacement symlink. */
export async function previewCanonicalFile(
  path: string,
): Promise<FilePreviewResult> {
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    throw new WorkspaceOperationError(
      'workspace_path_missing',
      '文件不存在或已被移除。',
    )
  }
  if (canonical !== path)
    throw new WorkspaceOperationError(
      'reference_target_changed',
      '文件位置已改变，请重新打开引用。',
    )
  const reader = new WorkspaceFilesService({
    resolveProject: () => ({
      sessionId: 'preview',
      projectRoot: dirname(canonical),
    }),
  })
  const value = await reader.read({
    sessionId: 'preview',
    relativePath: basename(canonical),
  })
  const result = filePreviewResult(value)
  // Documents with an ASCII header (e.g. PDF) are still binary, not source text.
  if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|rtf)$/i.test(canonical))
    return { ...result, kind: 'binary', content: undefined, truncated: false }
  return result
}
