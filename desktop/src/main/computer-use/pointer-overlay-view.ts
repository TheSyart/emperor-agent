/**
 * The Agent's on-screen pointer: an arrow drawn where a desktop action
 * lands, while the user's own mouse stays where it is. The pure parts live
 * here; `pointer-overlay.ts` owns the window.
 */

export interface DesktopPointer {
  /** Global screen points (the same space as Electron's DIP on macOS). */
  readonly x: number
  readonly y: number
  /** The target window is frontmost at this point. */
  readonly visible: boolean
  /** Where a drag ends. */
  readonly to?: { readonly x: number; readonly y: number }
}

/** What the desktop driver tells the overlay around an action. */
export type PointerSignal =
  | { readonly kind: 'move'; readonly pointer: DesktopPointer }
  /** A pointer-type action is about to hit-test: stay out of its way. */
  | { readonly kind: 'hide' }
  /** That action sent nothing: show the pointer where it was. */
  | { readonly kind: 'restore' }

export const POINTER_SIZE = 32

interface Bounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The window's top-left corner, one point past the action point: the arrow
 * tip sits at the point while the window never covers the point itself.
 */
export function pointerWindowOrigin(point: { x: number; y: number }): {
  x: number
  y: number
} {
  return { x: Math.round(point.x) + 1, y: Math.round(point.y) + 1 }
}

/** A point off every display is not shown. */
export function onSomeDisplay(
  point: { x: number; y: number },
  displays: readonly Bounds[],
): boolean {
  return displays.some(
    (display) =>
      point.x >= display.x &&
      point.y >= display.y &&
      point.x < display.x + display.width &&
      point.y < display.y + display.height,
  )
}

interface PointerStatus {
  readonly enabled: boolean
  readonly stopped: boolean
  readonly targets: readonly {
    readonly driver: string
    readonly state: string
    readonly control: string
  }[]
}

/** The pointer shows only while the Agent controls a desktop window. */
export function pointerAllowed(status: PointerStatus | null): boolean {
  if (!status?.enabled || status.stopped) return false
  return status.targets.some(
    (target) =>
      target.driver === 'desktop' &&
      target.control === 'agent' &&
      target.state !== 'closed' &&
      target.state !== 'lost',
  )
}

/** A hollow arrow with its tip at the window's top-left corner. */
export function pointerOverlayHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
    svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
  </style>
</head>
<body><svg width="${POINTER_SIZE}" height="${POINTER_SIZE}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M1 1 L1 23 L7 17.5 L11 26.5 L15 24.8 L11 16 L18.5 16 Z" fill="rgba(26,20,16,.55)" stroke="#d6ac5c" stroke-width="1.6" stroke-linejoin="round"/></svg></body>
</html>`
}
