import * as fs from 'node:fs'

export interface Bounds {
  width: number
  height: number
  x?: number
  y?: number
}

// Full-workbench window sizing (deliberately larger than the desktop-pet floater).
export const DEFAULT_BOUNDS = { width: 1280, height: 832 } as const
export const MIN_BOUNDS = { width: 960, height: 640 } as const

function defaultReadFile(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

function clampSize(value: unknown, fallback: number, min: number): number {
  const n = Number(value)
  const base = Number.isFinite(n) ? n : fallback
  return Math.max(Math.round(base), min)
}

// Produce Electron-ready bounds. Width/height are always present and never below
// MIN_BOUNDS; x/y are included only when both are finite numbers, otherwise
// omitted so Electron centers the window.
export function normalizeBounds(raw: Partial<Bounds> = {}): Bounds {
  const bounds: Bounds = {
    width: clampSize(raw.width, DEFAULT_BOUNDS.width, MIN_BOUNDS.width),
    height: clampSize(raw.height, DEFAULT_BOUNDS.height, MIN_BOUNDS.height),
  }
  if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    bounds.x = Math.round(raw.x as number)
    bounds.y = Math.round(raw.y as number)
  }
  return bounds
}

export interface ReadBoundsOptions {
  readFile?: (p: string) => string
}

// Read persisted bounds; any read/parse failure yields the default size so the
// window always opens.
export function readBounds(
  boundsPath: string,
  { readFile = defaultReadFile }: ReadBoundsOptions = {},
): Bounds {
  try {
    return normalizeBounds(JSON.parse(readFile(boundsPath)))
  } catch {
    return { ...DEFAULT_BOUNDS }
  }
}

// Keep only the geometry fields from an Electron getBounds() result before
// writing to disk.
export function pickBounds(boundsLike: Partial<Bounds> = {}): Bounds {
  const { x, y, width, height } = boundsLike
  return { x, y, width: width as number, height: height as number }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** How much of a window must lie on a display for it to count as visible there. */
const MIN_VISIBLE = { width: 200, height: 100 } as const

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(
      0,
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    ),
    height: Math.max(
      0,
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
    ),
  }
}

/**
 * Fit restored bounds to the displays connected now (MAIN-19): a window
 * that is no longer visibly on any display (an unplugged monitor, a few
 * pixels peeking in) loses its position so Electron centres it; a window
 * larger than its display shrinks to the display's work area and moves
 * inside it. The minimum size always wins.
 */
export function fitBoundsToDisplays(
  bounds: Bounds,
  workAreas: readonly Rect[],
  primary: Rect,
  min: { width: number; height: number } = MIN_BOUNDS,
): Bounds {
  const hasPosition = bounds.x !== undefined && bounds.y !== undefined
  let display = primary
  let visible = false
  if (hasPosition) {
    const rect = {
      x: bounds.x as number,
      y: bounds.y as number,
      width: bounds.width,
      height: bounds.height,
    }
    let best = 0
    for (const area of workAreas) {
      const shared = overlap(rect, area)
      const area2 = shared.width * shared.height
      if (
        shared.width >= Math.min(MIN_VISIBLE.width, rect.width) &&
        shared.height >= Math.min(MIN_VISIBLE.height, rect.height) &&
        area2 > best
      ) {
        best = area2
        display = area
        visible = true
      }
    }
  }
  const width = Math.max(min.width, Math.min(bounds.width, display.width))
  const height = Math.max(min.height, Math.min(bounds.height, display.height))
  if (!visible) return { width, height }
  const clamp = (value: number, low: number, high: number) =>
    Math.min(Math.max(value, low), Math.max(low, high))
  return {
    x: clamp(bounds.x as number, display.x, display.x + display.width - width),
    y: clamp(
      bounds.y as number,
      display.y,
      display.y + display.height - height,
    ),
    width,
    height,
  }
}
