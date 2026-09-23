/**
 * Embedded browser pane model (pure): loopback detection for 在外部打开, the
 * sticky load-error reducer, and the placement rule of the native view.
 *
 * The native view is drawn by main above the whole DOM, so the pane hides it
 * (bounds null) whenever DOM content must show where it sits: the pane or its
 * column is not on screen, a drag or column animation is running, a modal
 * layer or a floating menu is open, a floating popover overlaps it, or the
 * page failed (the pane draws its own error state instead).
 */
import type { BrowserViewBounds, BrowserViewState } from '../../api/backend'

/** Smallest rectangle main accepts; anything smaller hides the view. */
export const BROWSER_MIN_WIDTH = 120
export const BROWSER_MIN_HEIGHT = 80

/**
 * Whether `url` points at this machine (localhost, *.localhost, 127/8,
 * 0.0.0.0, [::1], [::] and IPv4-mapped loopback) — mirrors main's
 * `isLocalHostname`. Unparseable input counts as local (never handed out).
 */
export function isLoopbackUrl(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return true
  }
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (/^127(?:\.\d{1,3}){3}$/.test(host) || host === '0.0.0.0') return true
  if (host === '::1' || host === '::') return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (!mapped) return false
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return high >> 8 === 127 || (high === 0 && low === 0)
}

/**
 * 在外部打开 is offered for credential-free remote http(s) pages only; the
 * system browser refuses addresses of this machine.
 */
export function externalOpenAllowed(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password || !parsed.hostname) return false
  return !isLoopbackUrl(url)
}

/** What the pane knows about the page: the last pushed state + load error. */
export interface BrowserPage {
  state: BrowserViewState | null
  /** Load failure shown instead of the page ('' when none). */
  error: string
  /** URL the error belongs to (it survives the follow-up state pushes). */
  errorUrl: string
}

export function emptyBrowserPage(): BrowserPage {
  return { state: null, error: '', errorUrl: '' }
}

/**
 * Fold a main-process state push into the page. Main reports a failure once
 * (`error` on the did-fail-load update); the stop-loading update that follows
 * carries no error, so the error sticks while the view stays on that URL
 * (or Chromium's error page). User actions clear it (`clearBrowserError`).
 */
export function applyBrowserState(
  page: BrowserPage,
  next: BrowserViewState,
): BrowserPage {
  if (next.error) return { state: next, error: next.error, errorUrl: next.url }
  const sameFailure =
    Boolean(page.error) &&
    (next.url === page.errorUrl || next.url.startsWith('chrome-error:'))
  if (sameFailure) return { ...page, state: { ...next, url: page.errorUrl } }
  return { state: next, error: '', errorUrl: '' }
}

/** A user action (submit, back, forward, reload) retries: drop the error. */
export function clearBrowserError(page: BrowserPage): BrowserPage {
  return page.error ? { ...page, error: '', errorUrl: '' } : page
}

/** A DOM layer that may cover the native view. */
export interface BrowserOverlay {
  /** A menu (ui/Menu or role=menu): hides the view wherever it is. */
  menu: boolean
  /** A modal (aria-modal): hides the view wherever it is. */
  modal: boolean
  /** Positioned out of flow (fixed / absolute): a floating layer. */
  floating: boolean
  rect: BrowserViewBounds
}

export interface BrowserPlacement {
  /** The pane shows on screen and has no error state to draw. */
  shown: boolean
  /** A column / pane resize drag is running. */
  dragging: boolean
  /** The frame columns are animating. */
  transitioning: boolean
  /** A ui/modalStack layer is open. */
  modalOpen: boolean
  overlays: readonly BrowserOverlay[]
}

export function rectsIntersect(
  a: BrowserViewBounds,
  b: BrowserViewBounds,
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

/** Where to place the native view, or null to hide it. */
export function browserViewBounds(
  rect: BrowserViewBounds | null,
  placement: BrowserPlacement,
): BrowserViewBounds | null {
  if (!rect || !placement.shown) return null
  if (placement.dragging || placement.transitioning || placement.modalOpen)
    return null
  if (rect.width < BROWSER_MIN_WIDTH || rect.height < BROWSER_MIN_HEIGHT)
    return null
  for (const overlay of placement.overlays) {
    if (overlay.modal) return null
    if (!overlay.floating) continue
    if (overlay.menu) return null
    if (
      overlay.rect.width > 0 &&
      overlay.rect.height > 0 &&
      rectsIntersect(overlay.rect, rect)
    )
      return null
  }
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}
