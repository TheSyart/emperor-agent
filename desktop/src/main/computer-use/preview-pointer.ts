/**
 * The Agent's pointer on the conversation preview: where a desktop or
 * built-in browser action lands, as a share (0–1) of the target window or
 * page, for its preview card to draw the same arrow there. The on-screen
 * pointer (`pointer-overlay.ts`) shows only where the target window is
 * frontmost; this one also shows a window covered by Emperor. A Chrome/Edge
 * tab's preview is its latest screenshot, so it gets none. Pure, apart from
 * the relay's `send`.
 */

import type { ActHooks } from '@emperor/core/host-capabilities'
import type { AgentPreviewPointer } from '../../shared/ipc-contract'
import type { LandingPoint, RendererActHooks } from './cdp/renderer-actions'
import { agentControls, type Bounds } from './pointer-overlay-view'

type Point = { readonly x: number; readonly y: number }

/** Drivers whose preview is a live picture of the whole window or page. */
const LIVE_PICTURE_DRIVERS: ReadonlySet<string> = new Set([
  'desktop',
  'embedded-browser',
])

/**
 * A point as a share of a frame, edges included; null without a usable
 * frame, or for a point beside it (a menu bar item, a pop-up menu): the
 * picture shows the window alone.
 */
export function previewRatio(
  point: Point,
  frame: Bounds | undefined,
): Point | null {
  if (frame === undefined || !(frame.width > 0) || !(frame.height > 0))
    return null
  const x = (point.x - frame.x) / frame.width
  const y = (point.y - frame.y) / frame.height
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null
  return { x, y }
}

/** A desktop action's point on its window (the Helper's `pointer.window`). */
export function desktopPreviewPointer(
  targetId: string,
  point: Point,
  window: Bounds | undefined,
): AgentPreviewPointer | null {
  const at = previewRatio(point, window)
  return at === null ? null : { targetId, ...at }
}

/** A built-in browser action's point on the tab's viewport. */
export function pagePreviewPointer(
  targetId: string,
  landing: LandingPoint,
): AgentPreviewPointer | null {
  const at = previewRatio(landing, { x: 0, y: 0, ...landing.viewport })
  return at === null ? null : { targetId, ...at }
}

/**
 * Act hooks that also put a built-in browser action's landing point on the
 * preview. Without a listener, the plain hooks: nothing is measured.
 */
export function withPreviewPointer(
  hooks: ActHooks,
  targetId: string,
  send: ((pointer: AgentPreviewPointer) => void) | undefined,
): RendererActHooks {
  if (send === undefined) return hooks
  return {
    dispatched: () => hooks.dispatched(),
    landed: (landing) => {
      const pointer = pagePreviewPointer(targetId, landing)
      if (pointer !== null) send(pointer)
    },
  }
}

interface PreviewPointerStatus {
  readonly enabled: boolean
  readonly targets: readonly {
    readonly targetId: string
    readonly driver: string
    readonly state: string
    readonly control: string
  }[]
}

/**
 * Only for a desktop window or built-in tab the Agent controls, while
 * computer use is on.
 */
export function previewPointerAllowed(
  status: PreviewPointerStatus | null,
  targetId: string,
): boolean {
  if (!status?.enabled) return false
  const target = status.targets.find((item) => item.targetId === targetId)
  return (
    target !== undefined &&
    LIVE_PICTURE_DRIVERS.has(target.driver) &&
    agentControls(target)
  )
}

/**
 * Main's relay to the renderer: checks the target, then sends. Best effort:
 * nothing here ever fails the action that reported the point.
 */
export function createPreviewPointerRelay(options: {
  status(): PreviewPointerStatus | null
  send(pointer: AgentPreviewPointer): void
}): (pointer: AgentPreviewPointer) => void {
  return (pointer) => {
    try {
      if (previewPointerAllowed(options.status(), pointer.targetId))
        options.send(pointer)
    } catch {
      // The preview is only a view of the action.
    }
  }
}
