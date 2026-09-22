import { ref, type CSSProperties, type Ref } from 'vue'

export type FloatingMenuPlacement = 'top' | 'bottom'

export interface FloatingMenuLayoutInput {
  buttonRect: Pick<DOMRect, 'top' | 'bottom' | 'right'>
  menuWidth: number
  menuHeight: number
  viewportWidth: number
  viewportHeight: number
  margin?: number
  gap?: number
  /** Preferred side; the menu flips only when that side lacks room. */
  prefer?: FloatingMenuPlacement
}

export interface FloatingMenuLayout {
  placement: FloatingMenuPlacement
  left: number
  top: number
  width: number
  maxHeight: number
}

export function floatingMenuLayout(
  input: FloatingMenuLayoutInput,
): FloatingMenuLayout {
  const margin = input.margin ?? 12
  const gap = input.gap ?? 8
  const menuWidth = Math.min(input.menuWidth, input.viewportWidth - margin * 2)
  const menuHeight = Math.min(
    input.menuHeight,
    input.viewportHeight - margin * 2,
  )
  const spaceAbove = input.buttonRect.top - margin - gap
  const spaceBelow =
    input.viewportHeight - input.buttonRect.bottom - margin - gap
  const placeBelow =
    input.prefer === 'bottom'
      ? !(spaceBelow < menuHeight && spaceAbove > spaceBelow)
      : spaceAbove < menuHeight && spaceBelow > spaceAbove
  const maxHeight = Math.max(180, placeBelow ? spaceBelow : spaceAbove)
  const left = clamp(
    input.buttonRect.right - menuWidth,
    margin,
    input.viewportWidth - menuWidth - margin,
  )
  const top = placeBelow
    ? clamp(
        input.buttonRect.bottom + gap,
        margin,
        input.viewportHeight - menuHeight - margin,
      )
    : clamp(
        input.buttonRect.top - gap - menuHeight,
        margin,
        input.viewportHeight - menuHeight - margin,
      )

  return {
    placement: placeBelow ? 'bottom' : 'top',
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(menuWidth),
    maxHeight: Math.round(maxHeight),
  }
}

export function useFloatingMenu(opts: {
  open: Ref<boolean>
  button: Ref<HTMLElement | null>
  menu: Ref<HTMLElement | null>
  fallbackWidth: number
  fallbackHeight: number
  onClose: () => void
  /** Preferred side (default 'top', the upward composer menus). */
  prefer?: () => FloatingMenuPlacement | undefined
}) {
  const style = ref<CSSProperties>({})
  const placement = ref<FloatingMenuPlacement>('top')
  let raf = 0

  function position() {
    const button = opts.button.value
    const menu = opts.menu.value
    if (!button || !menu) return
    const layout = floatingMenuLayout({
      buttonRect: button.getBoundingClientRect(),
      menuWidth: menu.offsetWidth || opts.fallbackWidth,
      menuHeight: menu.offsetHeight || opts.fallbackHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      prefer: opts.prefer?.(),
    })
    placement.value = layout.placement
    style.value = {
      left: `${layout.left}px`,
      top: `${layout.top}px`,
      width: `${layout.width}px`,
      maxHeight: `${layout.maxHeight}px`,
    }
  }

  function schedulePosition() {
    if (!opts.open.value) return
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      raf = 0
      position()
    })
  }

  function isInside(target: EventTarget | null) {
    return (
      target instanceof Node &&
      (Boolean(opts.button.value?.contains(target)) ||
        Boolean(opts.menu.value?.contains(target)))
    )
  }

  function onDocumentPointerDown(event: PointerEvent) {
    if (!isInside(event.target)) opts.onClose()
  }

  function onDocumentFocusIn(event: FocusEvent) {
    if (!isInside(event.target)) opts.onClose()
  }

  function addListeners() {
    window.addEventListener('resize', schedulePosition)
    window.addEventListener('scroll', schedulePosition, true)
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    document.addEventListener('focusin', onDocumentFocusIn, true)
  }

  function removeListeners() {
    window.removeEventListener('resize', schedulePosition)
    window.removeEventListener('scroll', schedulePosition, true)
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    document.removeEventListener('focusin', onDocumentFocusIn, true)
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  return {
    style,
    placement,
    position,
    addListeners,
    removeListeners,
  }
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}
