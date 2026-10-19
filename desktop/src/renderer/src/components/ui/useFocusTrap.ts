/**
 * Focus handling shared by every modal layer (DS-05): Modal, SettingsModal,
 * the image lightbox and the first-run dialog.
 *
 * While active:
 * - focus moves into the container: `[data-autofocus]` first, else the first
 *   control that is not a dismiss button (`[data-dismiss]`), else the first
 *   control, else the container itself;
 * - Tab and Shift+Tab wrap inside the container, and a Tab pressed with
 *   focus outside it pulls focus back in (only the topmost trap acts);
 * - everything outside the container gets the `inert` attribute (the
 *   siblings of the container and of each ancestor up to <body>), except
 *   overlays that must stay usable above a dialog (`[data-overlay-keep]`,
 *   the toast stack).
 * On deactivation the inert flags are restored and focus returns to the
 * element that had it before (when it is still in the document).
 */
import { onScopeDispose, watch, type Ref } from 'vue'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Keyboard-reachable controls inside `root`, in document order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.hidden &&
      !element.closest('[inert]') &&
      !element.closest('[aria-hidden="true"]'),
  )
}

export interface FocusTrapOptions {
  /** Element to focus on activation (overrides the default choice). */
  initialFocus?: () => HTMLElement | null | undefined
  /** Return focus to the previously focused element (default true). */
  restoreFocus?: boolean
  /**
   * The overlay the container sits in (mask and panel); everything outside
   * it goes inert. Defaults to the container.
   */
  layer?: () => HTMLElement | null | undefined
}

interface Trap {
  container: () => HTMLElement | null
}

const traps: Trap[] = []

function focus(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.defaultPrevented) return
  const container = traps[traps.length - 1]?.container()
  if (!container) return
  const items = focusableWithin(container)
  const active = document.activeElement
  const inside = active instanceof Node && container.contains(active)
  if (items.length === 0) {
    event.preventDefault()
    focus(container)
    return
  }
  const first = items[0]!
  const last = items[items.length - 1]!
  if (!inside) {
    event.preventDefault()
    focus(event.shiftKey ? last : first)
  } else if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault()
    focus(last)
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    focus(first)
  }
}

function initialTarget(container: HTMLElement): HTMLElement {
  const items = focusableWithin(container)
  return (
    container.querySelector<HTMLElement>('[data-autofocus]') ??
    items.find((element) => !element.closest('[data-dismiss]')) ??
    items[0] ??
    container
  )
}

/**
 * Trap focus in `container` while `active` is true. Scope-bound: an
 * unmounted owner releases its trap.
 */
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  active: Ref<boolean> | (() => boolean),
  options: FocusTrapOptions = {},
): void {
  const trap: Trap = { container: () => container.value }
  let engaged = false
  let previous: HTMLElement | null = null
  let inertElements: { element: HTMLElement; inert: boolean }[] = []

  function engage(root: HTMLElement): void {
    engaged = true
    const current = document.activeElement
    previous =
      current instanceof HTMLElement && !root.contains(current) ? current : null
    if (traps.length === 0) document.addEventListener('keydown', onKeydown)
    traps.push(trap)
    // Siblings of the container and of each ancestor up to <body>: a
    // teleported dialog leaves the app root inert, one rendered inside the
    // app leaves the rest of the app inert.
    for (
      let node: HTMLElement = options.layer?.() ?? root;
      node.parentElement && node !== document.body;
      node = node.parentElement
    ) {
      for (const element of node.parentElement.children) {
        if (!(element instanceof HTMLElement) || element === node) continue
        if (element.hasAttribute('data-overlay-keep')) continue
        if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE')
          continue
        inertElements.push({ element, inert: element.hasAttribute('inert') })
        element.setAttribute('inert', '')
      }
    }
    const target = options.initialFocus?.() ?? initialTarget(root)
    if (target === root && !root.hasAttribute('tabindex'))
      root.setAttribute('tabindex', '-1')
    focus(target)
  }

  function release(): void {
    if (!engaged) return
    engaged = false
    const index = traps.indexOf(trap)
    if (index >= 0) traps.splice(index, 1)
    if (traps.length === 0) document.removeEventListener('keydown', onKeydown)
    for (const { element, inert } of inertElements)
      element.toggleAttribute('inert', inert)
    inertElements = []
    const target = previous
    previous = null
    if (
      options.restoreFocus !== false &&
      target?.isConnected &&
      !target.closest('[inert]')
    )
      focus(target)
  }

  watch(
    () =>
      [
        typeof active === 'function' ? active() : active.value,
        container.value,
      ] as const,
    ([on, root]) => {
      if (typeof document === 'undefined') return
      if (on && root && !engaged) engage(root)
      else if ((!on || !root) && engaged) release()
    },
    { immediate: true, flush: 'post' },
  )
  onScopeDispose(release)
}
