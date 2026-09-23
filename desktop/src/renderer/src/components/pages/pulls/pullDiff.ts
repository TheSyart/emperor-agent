/**
 * Unified diff of a Pull Request (`gh pr diff`) → per-file sections for the
 * 「查看 diff」 tab: path / rename / new / deleted / binary, +/− counts, and
 * DiffBlock hunks. Pure; imported only by the lazily loaded PullRequestDiff.
 */
import { hunksFromUnifiedDiff } from '../../conversation/tools/toolModel'
import type { DiffHunk } from '../../ui/diffRows'

export type PullDiffFileStatus =
  'modified' | 'added' | 'deleted' | 'renamed' | 'binary'

export interface PullDiffFile {
  /** New path (old path for a deletion). */
  path: string
  /** Previous path of a rename. */
  oldPath: string | null
  status: PullDiffFileStatus
  additions: number
  deletions: number
  /** DiffBlock material (empty for binary files and pure renames). */
  hunks: DiffHunk[]
}

function stripSide(path: string, prefix: 'a/' | 'b/'): string {
  let value = path.trim()
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"'))
    value = value.slice(1, -1)
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

/** `diff --git a/x b/y` → [x, y] (best effort for paths with spaces). */
function headerPaths(header: string): [string, string] {
  const rest = header.slice('diff --git '.length)
  const split = rest.indexOf(' b/')
  if (split < 0) return [stripSide(rest, 'a/'), stripSide(rest, 'a/')]
  return [
    stripSide(rest.slice(0, split), 'a/'),
    stripSide(rest.slice(split + 1), 'b/'),
  ]
}

function parseDiffSection(lines: string[]): PullDiffFile {
  let [oldPath, newPath] = headerPaths(lines[0] ?? '')
  let status: PullDiffFileStatus = 'modified'
  let additions = 0
  let deletions = 0
  let inHunks = false
  for (const line of lines.slice(1)) {
    if (!inHunks) {
      if (line.startsWith('@@')) inHunks = true
      else if (line.startsWith('new file mode')) status = 'added'
      else if (line.startsWith('deleted file mode')) status = 'deleted'
      else if (line.startsWith('rename from '))
        oldPath = line.slice('rename from '.length)
      else if (line.startsWith('rename to ')) {
        newPath = line.slice('rename to '.length)
        if (status === 'modified') status = 'renamed'
      } else if (
        line.startsWith('Binary files ') ||
        line.startsWith('GIT binary patch')
      )
        status = 'binary'
      else if (line.startsWith('--- ') && line !== '--- /dev/null')
        oldPath = stripSide(line.slice(4), 'a/')
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null')
        newPath = stripSide(line.slice(4), 'b/')
      continue
    }
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  const path = status === 'deleted' ? oldPath : newPath
  const label =
    status === 'renamed' && oldPath !== newPath
      ? `${oldPath} → ${newPath}`
      : path
  return {
    path,
    oldPath: status === 'renamed' ? oldPath : null,
    status,
    additions,
    deletions,
    hunks:
      status === 'binary' ? [] : hunksFromUnifiedDiff(lines.join('\n'), label),
  }
}

/** Split a multi-file unified diff (`gh pr diff`) into per-file sections. */
export function splitPullRequestDiff(diff: string): PullDiffFile[] {
  const files: PullDiffFile[] = []
  let section: string[] | null = null
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (section) files.push(parseDiffSection(section))
      section = [line]
    } else if (section) section.push(line)
  }
  if (section) files.push(parseDiffSection(section))
  return files
}

const LOCKFILE_PATTERN =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|uv\.lock)$/

/** Changed lines above which a file starts collapsed (render cost). */
export const DIFF_FILE_OPEN_MAX_LINES = 400
/** Files after this many start collapsed. */
export const DIFF_FILES_OPEN_MAX = 20

/** Small, non-generated files near the top render expanded. */
export function diffFileStartsOpen(file: PullDiffFile, index: number): boolean {
  return (
    index < DIFF_FILES_OPEN_MAX &&
    file.hunks.length > 0 &&
    file.additions + file.deletions <= DIFF_FILE_OPEN_MAX_LINES &&
    !LOCKFILE_PATTERN.test(file.path)
  )
}

export function diffFileStatusLabel(status: PullDiffFileStatus): string {
  if (status === 'added') return '新文件'
  if (status === 'deleted') return '已删除'
  if (status === 'renamed') return '重命名'
  if (status === 'binary') return '二进制'
  return ''
}
