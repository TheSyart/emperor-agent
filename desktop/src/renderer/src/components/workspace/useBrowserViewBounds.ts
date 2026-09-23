/**
 * Keeps the native browser view glued to the BrowserPane's viewport slot.
 *
 * The view is a main-process WebContentsView drawn above the whole DOM, so
 * it is placed (setBrowserBounds(rect)) only while nothing in the DOM must
 * show there, and hidden (null) otherwise — see `browserViewBounds` for the
 * rule. Signals watched here:
 * - the slot's size (ResizeObserver) and window resizes;
 * - drags: AppFrame's `data-dragging` and useResizable's body class;
 * - AppFrame column animations (grid-template-columns transitions);
 * - ui/modalStack layers;
 * - floating menus / popovers: teleports into <body> (MutationObserver) and
 *   in-place popovers opened by a pointer or key press (re-checked a frame
 *   after each press).
 * Every change schedules one measurement per animation frame; the result is
 * sent only when it differs from the last one.
 */
import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { setBrowserBounds, type BrowserViewBounds } from '../../api/backend'
import { modalLayerCount, onModalLayersChange } from '../ui/modalStack'
import { browserViewBounds, type BrowserOverlay } from './browserModel'

/** Menus hide the view wherever they open. */
const MENU_SELECTOR = '.ds-menu, [role="menu"]'
/** Popovers hide it only when they overlap; aria-modal ones always. */
const POPOVER_SELECTOR =
  '[role="dialog"], [role="listbox"], [aria-modal="true"]'
/** Body class useResizable sets while a pane separator is dragged. */
const RESIZING_CLASS = 'workspace-resizing'
/** Upper bound of a frame column animation (transitionend may never come). */
const TRANSITION_FALLBACK_MS = 800

export interface BrowserViewBoundsOptions {
  /** The slot the page should cover. */
  viewport: Ref<HTMLElement | null>
  /** The pane is on screen and wants the page drawn (no error state). */
  shown: () => boolean
}

export function useBrowserViewBounds(options: BrowserViewBoundsOptions): {
  /** Re-measure on the next frame. */
  schedule: () => void
} {
  let frameId = 0
  let lastSent: string | undefined
  let transitioning = false
  let transitionTimer: ReturnType<typeof setTimeout> | undefined
  let appFrame: HTMLElement | null = null
  const cleanups: Array<() => void> = []

  function schedule(): void {
    if (frameId || typeof requestAnimationFrame === 'undefined') return
    frameId = requestAnimationFrame(() => {
      frameId = 0
      sync()
    })
  }

  function send(bounds: BrowserViewBounds | null): void {
    const key = JSON.stringify(bounds)
    if (key === lastSent) return
    lastSent = key
    setBrowserBounds(bounds)
  }

  function sync(): void {
    const slot = options.viewport.value
    const rect = slot?.getBoundingClientRect()
    send(
      browserViewBounds(
        rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null,
        {
          shown: options.shown(),
          dragging: dragging(),
          transitioning,
          modalOpen: modalLayerCount() > 0,
          overlays: overlays(slot),
        },
      ),
    )
  }

  function dragging(): boolean {
    return (
      document.body.classList.contains(RESIZING_CLASS) ||
      Boolean(appFrame?.hasAttribute('data-dragging'))
    )
  }

  function overlays(slot: HTMLElement | null | undefined): BrowserOverlay[] {
    const found: BrowserOverlay[] = []
    const nodes = document.querySelectorAll<HTMLElement>(
      `${MENU_SELECTOR}, ${POPOVER_SELECTOR}`,
    )
    for (const node of nodes) {
      if (slot?.contains(node)) continue
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const rect = node.getBoundingClientRect()
      found.push({
        menu: node.matches(MENU_SELECTOR),
        modal: node.getAttribute('aria-modal') === 'true',
        floating: style.position === 'fixed' || style.position === 'absolute',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      })
    }
    return found
  }

  function onTransition(event: TransitionEvent): void {
    if (event.target !== appFrame) return
    if (event.propertyName !== 'grid-template-columns') return
    clearTimeout(transitionTimer)
    transitioning = event.type === 'transitionrun'
    if (transitioning)
      transitionTimer = setTimeout(() => {
        transitioning = false
        schedule()
      }, TRANSITION_FALLBACK_MS)
    schedule()
  }

  function listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    capture = false,
  ): void {
    target.addEventListener(type, handler, capture)
    cleanups.push(() => target.removeEventListener(type, handler, capture))
  }

  onMounted(() => {
    const slot = options.viewport.value
    appFrame = slot?.closest<HTMLElement>('.app-frame') ?? null
    if (typeof ResizeObserver !== 'undefined' && slot) {
      const resize = new ResizeObserver(schedule)
      resize.observe(slot)
      cleanups.push(() => resize.disconnect())
    }
    if (typeof MutationObserver !== 'undefined') {
      // Teleported menus / modals land in <body>; the drag class sits on it.
      const body = new MutationObserver(schedule)
      body.observe(document.body, {
        childList: true,
        attributes: true,
        attributeFilter: ['class'],
      })
      cleanups.push(() => body.disconnect())
      if (appFrame) {
        const frame = new MutationObserver(schedule)
        frame.observe(appFrame, {
          attributes: true,
          attributeFilter: ['data-dragging'],
        })
        cleanups.push(() => frame.disconnect())
      }
    }
    if (appFrame)
      for (const type of [
        'transitionrun',
        'transitionend',
        'transitioncancel',
      ] as const)
        listen(appFrame, type, onTransition as (event: Event) => void)
    listen(window, 'resize', schedule)
    // In-place popovers open on a press; check once the UI has updated.
    for (const type of ['pointerdown', 'click', 'keydown'] as const)
      listen(document, type, schedule, true)
    cleanups.push(onModalLayersChange(schedule))
    schedule()
  })

  watch(options.shown, schedule)

  onBeforeUnmount(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    if (frameId) cancelAnimationFrame(frameId)
    frameId = 0
    clearTimeout(transitionTimer)
    send(null)
  })

  return { schedule }
}
