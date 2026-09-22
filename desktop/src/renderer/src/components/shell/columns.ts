/**
 * Pure concession-chain column solver for the three-column AppFrame (port of
 * dsh ui-layout columns.ts). Chain order: keep center >= CENTER_MIN by
 * shrinking details, then auto-closing it (derived zero width — preferences
 * are never rewritten, so widening the window restores them). The sidebar
 * never concedes: its rendered width is the drag preference (or the 56px
 * rail); center absorbs any remaining deficit as the last resort. The
 * SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame, so the solver
 * stays breakpoint-free.
 */

/** Resolved widths for one frame. */
export interface Columns {
  sidebar: number
  center: number
  details: number
}

/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
export const SIDEBAR_MIN = 264
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail. */
export const SIDEBAR_AUTO_COLLAPSE = 1024
export const DETAILS_MIN = 300
export const DETAILS_MAX = 520
export const DETAILS_DEFAULT = 360

export function clampWidth(px: number, min: number, max: number): number {
  if (!Number.isFinite(px)) return min
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: the output is a
 * function of (viewport, preferences) only.
 * @param viewport available frame width in px.
 * @param sidebar sidebar width preference in px (0 = closed → rail).
 * @param details details width preference in px (0 = closed).
 */
export function computeColumns(
  viewport: number,
  sidebar: number,
  details: number,
): Columns {
  const s =
    sidebar === 0
      ? SIDEBAR_COLLAPSED
      : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)

  if (s + d0 + CENTER_MIN <= viewport)
    return { sidebar: s, center: viewport - s - d0, details: d0 }

  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN)
  if (s + d1 + CENTER_MIN <= viewport)
    return { sidebar: s, center: CENTER_MIN, details: d1 }

  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 }
}
