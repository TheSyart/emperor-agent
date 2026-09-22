/**
 * Line-level unified diff for the write/edit result `meta` (UI only; the
 * model never sees it). Dependency-free: common prefix/suffix trimming plus
 * an LCS table on the changed middle, falling back to a whole-middle
 * replacement when the middle is too large for the table.
 */

/** Context lines around each hunk. */
export const DIFF_CONTEXT = 3
/** Maximum characters of the rendered diff kept in `meta.diff`. */
export const DIFF_MAX_CHARS = 20_000
/** Largest LCS table (cells) computed before degrading to a block replace. */
const MAX_LCS_CELLS = 4_000_000

type Op = { kind: ' ' | '-' | '+'; text: string }

export interface FsDiffSummary {
  added: number
  removed: number
  diff: string
  diffTruncated?: true
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function diffMiddle(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ kind: '+' as const, text }))
  if (m === 0) return a.map((text) => ({ kind: '-' as const, text }))
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [
      ...a.map((text) => ({ kind: '-' as const, text })),
      ...b.map((text) => ({ kind: '+' as const, text })),
    ]
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i]! })
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ kind: '-', text: a[i++]! })
    } else {
      ops.push({ kind: '+', text: b[j++]! })
    }
  }
  while (i < n) ops.push({ kind: '-', text: a[i++]! })
  while (j < m) ops.push({ kind: '+', text: b[j++]! })
  return ops
}

function lineOps(before: string[], after: string[]): Op[] {
  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++
  return [
    ...before.slice(0, prefix).map((text) => ({ kind: ' ' as const, text })),
    ...diffMiddle(
      before.slice(prefix, before.length - suffix),
      after.slice(prefix, after.length - suffix),
    ),
    ...before
      .slice(before.length - suffix)
      .map((text) => ({ kind: ' ' as const, text })),
  ]
}

function hunkRange(start: number, count: number): string {
  // Unified convention: an empty side names the line before the hunk.
  return `${count === 0 ? start - 1 : start},${count}`
}

/**
 * Unified diff of `before` → `after` (`before === null` is a create) with
 * added/removed line counts. The rendered text is capped at {@link DIFF_MAX_CHARS}.
 */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string,
): FsDiffSummary {
  const ops = lineOps(splitLines(before ?? ''), splitLines(after))
  let added = 0
  let removed = 0
  const changes: number[] = []
  ops.forEach((op, index) => {
    if (op.kind === '+') added++
    else if (op.kind === '-') removed++
    if (op.kind !== ' ') changes.push(index)
  })
  if (changes.length === 0) return { added, removed, diff: '' }

  // Line numbers before each op on either side.
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let oldLine = 0
  let newLine = 0
  for (const op of ops) {
    oldBefore.push(oldLine)
    newBefore.push(newLine)
    if (op.kind !== '+') oldLine++
    if (op.kind !== '-') newLine++
  }

  const out = [`--- ${before === null ? '/dev/null' : path}`, `+++ ${path}`]
  let cursor = 0
  while (cursor < changes.length) {
    const first = changes[cursor]!
    let last = first
    while (
      cursor + 1 < changes.length &&
      changes[cursor + 1]! - last - 1 <= 2 * DIFF_CONTEXT
    ) {
      cursor++
      last = changes[cursor]!
    }
    cursor++
    const start = Math.max(0, first - DIFF_CONTEXT)
    const end = Math.min(ops.length - 1, last + DIFF_CONTEXT)
    const slice = ops.slice(start, end + 1)
    const oldCount = slice.filter((op) => op.kind !== '+').length
    const newCount = slice.filter((op) => op.kind !== '-').length
    out.push(
      `@@ -${hunkRange(oldBefore[start]! + 1, oldCount)} +${hunkRange(newBefore[start]! + 1, newCount)} @@`,
    )
    for (const op of slice) out.push(`${op.kind}${op.text}`)
  }
  const diff = out.join('\n')
  if (diff.length <= DIFF_MAX_CHARS) return { added, removed, diff }
  return {
    added,
    removed,
    diff: `${diff.slice(0, DIFF_MAX_CHARS)}\n... (diff truncated)`,
    diffTruncated: true,
  }
}
