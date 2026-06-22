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
export function readBounds(boundsPath: string, { readFile = defaultReadFile }: ReadBoundsOptions = {}): Bounds {
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
