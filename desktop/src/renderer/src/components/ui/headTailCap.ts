/** Head/tail collapse arithmetic shared by the block primitives (dsh head-tail-cap). */
export interface HeadTailCap {
  /** Rows beyond the cap (≤ 0 when the body fits). */
  hidden: number
  /** The middle is currently collapsed. */
  capped: boolean
  headLines: number
  tailLines: number
}

export const DEFAULT_BLOCK_MAX_LINES = 16

export function headTailCap(
  total: number,
  maxLines: number,
  expanded: boolean,
): HeadTailCap {
  const hidden = total - maxLines
  const headLines = Math.ceil(maxLines / 2)
  return {
    hidden,
    capped: hidden > 0 && !expanded,
    headLines,
    tailLines: maxLines - headLines,
  }
}

/** Split rows into the visible head and tail given a cap result. */
export function capRows<T>(
  rows: readonly T[],
  cap: HeadTailCap,
): {
  head: readonly T[]
  tail: readonly T[]
} {
  if (!cap.capped) return { head: rows, tail: [] }
  return {
    head: rows.slice(0, cap.headLines),
    tail: rows.slice(rows.length - cap.tailLines),
  }
}
