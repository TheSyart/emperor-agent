import { onBeforeUnmount, ref, type Ref } from 'vue'

export type TooltipSide = 'top' | 'bottom' | 'right'

const GAP = 6
/**
 * Room a one-line bubble needs above its anchor; closer to the window top
 * (the 46px top bars of the frameless window, UI-S01) a `top` bubble opens
 * below instead.
 */
const TOP_ROOM = 40

/**
 * Hover / focus bubble state for one anchor element (DS-03). Tooltip.vue
 * wraps arbitrary content with it; IconButton attaches it to its own
 * <button> so the button stays the element its parent lays out.
 */
export function useTooltip(options: {
  anchor: Ref<HTMLElement | null>
  side: () => TooltipSide
  delayMs: () => number
  enabled: () => boolean
}) {
  const visible = ref(false)
  const position = ref({ left: '0px', top: '0px' })
  /** The side the bubble actually opens on (top flips near the window top). */
  const side = ref<TooltipSide>(options.side())
  let timer: ReturnType<typeof setTimeout> | undefined

  function place(): void {
    const rect = options.anchor.value?.getBoundingClientRect()
    if (!rect) return
    const wanted = options.side()
    side.value = wanted === 'top' && rect.top < TOP_ROOM ? 'bottom' : wanted
    if (side.value === 'right')
      position.value = {
        left: `${rect.right + GAP}px`,
        top: `${rect.top + rect.height / 2}px`,
      }
    else
      position.value = {
        left: `${rect.left + rect.width / 2}px`,
        top: `${side.value === 'top' ? rect.top - GAP : rect.bottom + GAP}px`,
      }
  }

  function show(): void {
    if (!options.enabled()) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      place()
      visible.value = true
    }, options.delayMs())
  }

  function hide(): void {
    clearTimeout(timer)
    visible.value = false
  }

  onBeforeUnmount(() => clearTimeout(timer))

  return {
    visible,
    position,
    side,
    show,
    hide,
    /** Listeners for the anchor element (`v-on="listeners"`). */
    listeners: {
      pointerenter: show,
      pointerleave: hide,
      focusin: show,
      focusout: hide,
      pointerdown: hide,
    },
  }
}
