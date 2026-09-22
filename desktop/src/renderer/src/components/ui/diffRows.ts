import { diffLines } from 'diff'

/** One file mutation (write/edit/memory_edit), in the shape DiffBlock draws. */
export interface DiffHunk {
  /** Changed file path, drawn verbatim as the hunk header. */
  path: string
  /** Prior content, or `null` for a new file (nothing on the removed side). */
  oldText: string | null
  /** Content after the change. */
  newText: string
}

export type DiffRowKind = 'path' | 'gap' | 'ctx' | 'del' | 'add'

export interface DiffRow {
  kind: DiffRowKind
  text: string
  /** 1-based line number on the old side (ctx/del). */
  oldNo?: number
  /** 1-based line number on the new side (ctx/add). */
  newNo?: number
}

export interface DiffRowsResult {
  rows: DiffRow[]
  added: number
  removed: number
  /** Distinct paths (two hunks in one file read as `1 file`). */
  files: number
}

/**
 * Split one side into content lines: empty text is zero lines and a single
 * trailing newline is a terminator, not an extra empty line (dsh rule).
 */
export function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Flatten hunks into display rows with a jsdiff line diff: unchanged runs keep
 * `context` lines around each change and collapse the rest into a `⋯` gap.
 */
export function buildDiffRows(
  diffs: readonly DiffHunk[],
  context = 3,
): DiffRowsResult {
  const rows: DiffRow[] = []
  const paths = new Set<string>()
  let added = 0
  let removed = 0
  let prevPath: string | undefined
  for (const hunk of diffs) {
    paths.add(hunk.path)
    rows.push(
      hunk.path !== prevPath
        ? { kind: 'path', text: hunk.path }
        : { kind: 'gap', text: '⋯' },
    )
    prevPath = hunk.path
    if (hunk.oldText === null) {
      contentLines(hunk.newText).forEach((text, index) => {
        rows.push({ kind: 'add', text, newNo: index + 1 })
        added++
      })
      continue
    }
    const changes = diffLines(hunk.oldText, hunk.newText)
    let oldNo = 1
    let newNo = 1
    changes.forEach((change, index) => {
      const lines = contentLines(change.value)
      if (change.added) {
        for (const text of lines)
          rows.push({ kind: 'add', text, newNo: newNo++ })
        added += lines.length
        return
      }
      if (change.removed) {
        for (const text of lines)
          rows.push({ kind: 'del', text, oldNo: oldNo++ })
        removed += lines.length
        return
      }
      const first = index === 0
      const last = index === changes.length - 1
      const keepHead = first ? 0 : context
      const keepTail = last ? 0 : context
      const ctx = (text: string, offset: number): DiffRow => ({
        kind: 'ctx',
        text,
        oldNo: oldNo + offset,
        newNo: newNo + offset,
      })
      if (lines.length <= keepHead + keepTail) {
        lines.forEach((text, offset) => rows.push(ctx(text, offset)))
      } else {
        lines
          .slice(0, keepHead)
          .forEach((text, offset) => rows.push(ctx(text, offset)))
        rows.push({ kind: 'gap', text: '⋯' })
        const tailStart = lines.length - keepTail
        lines
          .slice(tailStart)
          .forEach((text, offset) => rows.push(ctx(text, tailStart + offset)))
      }
      oldNo += lines.length
      newNo += lines.length
    })
  }
  // A lone trailing gap (unchanged tail with no following change) says nothing.
  while (rows.length > 0 && rows[rows.length - 1].kind === 'gap') rows.pop()
  return { rows, added, removed, files: paths.size }
}

/** The text a reader copies: each row's sign prefix plus content. */
export function diffCopyText(rows: readonly DiffRow[]): string {
  return rows
    .map((row) => {
      switch (row.kind) {
        case 'del':
          return `- ${row.text}`
        case 'add':
          return `+ ${row.text}`
        case 'ctx':
          return `  ${row.text}`
        default:
          return row.text
      }
    })
    .join('\n')
}

/** `└ +A -R · N file(s)` footer, identical to dsh's TUI/web diff cards. */
export function diffFooter(result: DiffRowsResult): string {
  return `└ +${result.added} -${result.removed} · ${result.files} file${result.files === 1 ? '' : 's'}`
}
