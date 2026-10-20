/**
 * Pure concession-chain column solver for the three-column AppFrame
 * (sidebar | center | workspace; port of dsh ui-layout columns.ts). Chain
 * order: keep center >= centerMin by shrinking the workspace, then
 * auto-closing it (derived zero width — preferences are never rewritten, so
 * widening the window restores them). The sidebar never concedes: its
 * rendered width is the drag preference (or the 56px rail); center absorbs
 * any remaining deficit as the last resort. The SIDEBAR_AUTO_COLLAPSE
 * breakpoint is consumed by AppFrame, so the solver stays breakpoint-free.
 */

/** Resolved widths for one frame. */
export interface Columns {
  sidebar: number
  center: number
  workspace: number
}

/** Center column floor of the Chat tab (and full-page routes). */
export const CENTER_MIN_CHAT = 480
/** Center column floor of the Trajectory tab (ledger + inspector column). */
export const CENTER_MIN_TRAJECTORY = 640
export const SIDEBAR_MIN = 264
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail. */
export const SIDEBAR_AUTO_COLLAPSE = 1024
export const WORKSPACE_MIN = 360
export const WORKSPACE_MAX = 960
export const WORKSPACE_DEFAULT = 560
/** Trajectory inspector column (inside the center column). */
export const INSPECTOR_MIN = 320
export const INSPECTOR_MAX = 720
export const INSPECTOR_DEFAULT = 420

export function clampWidth(px: number, min: number, max: number): number {
  if (!Number.isFinite(px)) return min
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: the output is a
 * function of (viewport, preferences, centerMin) only.
 * @param viewport available frame width in px.
 * @param sidebar sidebar width preference in px (0 = closed → rail).
 * @param workspace workspace width preference in px (0 = closed).
 * @param centerMin center floor the workspace concedes to (chat 480,
 *   trajectory 640).
 */
export function computeColumns(
  viewport: number,
  sidebar: number,
  workspace: number,
  centerMin: number = CENTER_MIN_CHAT,
): Columns {
  const s =
    sidebar === 0
      ? SIDEBAR_COLLAPSED
      : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const w0 =
    workspace === 0 ? 0 : clampWidth(workspace, WORKSPACE_MIN, WORKSPACE_MAX)

  if (s + w0 + centerMin <= viewport)
    return { sidebar: s, center: viewport - s - w0, workspace: w0 }

  const w1 = w0 === 0 ? 0 : Math.max(WORKSPACE_MIN, viewport - s - centerMin)
  if (s + w1 + centerMin <= viewport)
    return { sidebar: s, center: centerMin, workspace: w1 }

  return { sidebar: s, center: Math.max(0, viewport - s), workspace: 0 }
}
