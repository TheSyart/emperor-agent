import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from 'vue'
import { animateSpring } from './useSpring'

// Shared resizable-pane primitive. Replaces per-component mouse-only resizers
// with a Pointer Events pipeline (setPointerCapture + rAF-batched writes +
// velocity tracking + spring-to-snap on release), while preserving the existing
// keyboard and aria-slider semantics. Both panes call into this so the whole
// app shares one drag feel — direct 1:1 tracking during the move, a velocity-
// aware spring settle on release.

export interface UseResizableOptions {
  /** Current size in px (the single source of truth the caller renders from). */
  size: Ref<number>
  min: number
  max: number
  /** Which edge of the panel the separator sits on. */
  edge: 'left' | 'right' | 'top' | 'bottom'
  /** Snap points (px); on release the panel springs to the nearest one within
   *  snapThreshold of the projected resting point, else to the exact point. */
  snap?: number[]
  /** Distance (px) within which a snap point attracts the release. Default 24. */
  snapThreshold?: number
  /** Spring used for the release settle. Defaults to 'snappy' (no overshoot). */
  spring?: 'gentle' | 'snappy' | 'bouncy'
  /** Called once after the panel has settled (persist hook). */
  onCommit?: (px: number) => void
  /** Body class toggled during a drag (drives the global resize cursor). */
  resizingClass?: string
  /** Keyboard step / large step (with Shift). Defaults match existing panes. */
  step?: number
  largeStep?: number
  /** When false, pointer dragging is disabled (keyboard still works). */
  enabled?: Ref<boolean> | (() => boolean)
}

export interface UseResizable {
  separatorProps: {
    role: 'separator'
    tabindex: 0
    'aria-orientation': 'vertical' | 'horizontal'
    'aria-valuenow': ComputedRef<number>
    'aria-valuemin': number
    'aria-valuemax': number
    onPointerdown: (event: PointerEvent) => void
    onKeydown: (event: KeyboardEvent) => void
  }
  resizing: Ref<boolean>
}

interface PointerSample {
  t: number
  pos: number
}

const VELOCITY_WINDOW_MS = 80

export function useResizable(opts: UseResizableOptions): UseResizable {
  const resizing = ref(false)
  const horizontal = opts.edge === 'left' || opts.edge === 'right'
  const step = opts.step ?? 10
  const largeStep = opts.largeStep ?? 40
  const snapThreshold = opts.snapThreshold ?? 24
  const resizingClass = opts.resizingClass ?? 'workspace-resizing'

  let activePointerId: number | null = null
  let grabStartPos = 0
  let grabStartSize = 0
  let samples: PointerSample[] = []
  let rafId: number | null = null
  let pendingSize: number | null = null
  let cancelSettle: (() => void) | null = null
  let capturedEl: HTMLElement | null = null

  const clamp = (value: number): number =>
    Math.min(opts.max, Math.max(opts.min, value))

  const isEnabled = (): boolean => {
    const e = opts.enabled
    if (e === undefined) return true
    return typeof e === 'function' ? e() : e.value
  }

  function pointerPos(event: PointerEvent): number {
    return horizontal ? event.clientX : event.clientY
  }

  /** Delta from grab point to current pointer, mapped onto size growth. For a
   *  left-edge separator the panel grows as the pointer moves left (negative
   *  clientX delta); for right/bottom it grows moving right/down. */
  function sizeFromPointer(pos: number): number {
    const delta = pos - grabStartPos
    const signed = opts.edge === 'left' || opts.edge === 'top' ? -delta : delta
    return clamp(grabStartSize + signed)
  }

  function flushPending(): void {
    rafId = null
    if (pendingSize === null) return
    opts.size.value = pendingSize
    pendingSize = null
  }

  function scheduleWrite(pos: number): void {
    pendingSize = sizeFromPointer(pos)
    if (rafId === null) rafId = requestAnimationFrame(flushPending)
  }

  function recordSample(pos: number): void {
    const now = performance.now()
    samples.push({ t: now, pos })
    const cutoff = now - VELOCITY_WINDOW_MS
    while (samples.length > 2 && samples[0]!.t < cutoff) samples.shift()
  }

  function releaseVelocity(): number {
    if (samples.length < 2) return 0
    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const dt = (last.t - first.t) / 1000
    if (dt <= 0) return 0
    // Velocity in px/s of *pointer* motion; convert to size-growth direction.
    const pointerV = (last.pos - first.pos) / dt
    return opts.edge === 'left' || opts.edge === 'top' ? -pointerV : pointerV
  }

  function nearestSnap(target: number): number {
    const points = opts.snap
    if (!points || points.length === 0) return target
    let best = target
    let bestDistance = snapThreshold
    for (const point of points) {
      const distance = Math.abs(point - target)
      if (distance <= bestDistance) {
        bestDistance = distance
        best = point
      }
    }
    return clamp(best)
  }

  function onPointerdown(event: PointerEvent): void {
    if (!isEnabled()) return
    if (event.button !== 0) return
    cancelSettle?.()
    cancelSettle = null
    activePointerId = event.pointerId
    grabStartPos = pointerPos(event)
    grabStartSize = opts.size.value
    samples = []
    recordSample(grabStartPos)
    capturedEl = event.currentTarget as HTMLElement
    try {
      capturedEl.setPointerCapture(event.pointerId)
    } catch {
      // Capture is best-effort; window listeners below still track the drag.
    }
    resizing.value = true
    document.body.classList.add(resizingClass)
    window.addEventListener('pointermove', onPointermove)
    window.addEventListener('pointerup', onPointerup, { once: true })
    window.addEventListener('pointercancel', onPointercancel, { once: true })
    event.preventDefault()
  }

  function onPointermove(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) return
    recordSample(pointerPos(event))
    scheduleWrite(pointerPos(event))
  }

  function endDrag(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    flushPending()
    window.removeEventListener('pointermove', onPointermove)
    document.body.classList.remove(resizingClass)
    resizing.value = false
    if (capturedEl && activePointerId !== null) {
      try {
        capturedEl.releasePointerCapture(activePointerId)
      } catch {
        // Ignore — capture may already be released.
      }
    }
    capturedEl = null
    activePointerId = null
  }

  function onPointerup(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) return
    const velocity = releaseVelocity()
    endDrag()
    settle(velocity)
  }

  function onPointercancel(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) return
    endDrag()
    opts.onCommit?.(opts.size.value)
  }

  /** Spring from the release point (with the pointer's velocity) to the nearest
   *  snap point, so a flick throws the panel and it settles without a seam. */
  function settle(velocity: number): void {
    const from = opts.size.value
    // Project the resting point from momentum, then snap to it.
    const projected = from + projectMomentum(velocity)
    const to = nearestSnap(projected)
    if (from === to) {
      opts.onCommit?.(to)
      return
    }
    cancelSettle = animateSpring(from, to, {
      params: opts.spring ?? 'snappy',
      velocity,
      onUpdate: (v) => {
        opts.size.value = clamp(v)
      },
      onRest: () => {
        cancelSettle = null
        opts.size.value = to
        opts.onCommit?.(to)
      },
    })
  }

  function onKeydown(event: KeyboardEvent): void {
    let next = opts.size.value
    const grow = event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp')
    const shrink = event.key === (horizontal ? 'ArrowRight' : 'ArrowDown')
    // Match the existing left-edge convention (ArrowLeft grows a left panel).
    const growKey = opts.edge === 'left' || opts.edge === 'top' ? grow : shrink
    const shrinkKey = opts.edge === 'left' || opts.edge === 'top' ? shrink : grow
    if (growKey) next += event.shiftKey ? largeStep : step
    else if (shrinkKey) next -= event.shiftKey ? largeStep : step
    else if (event.key === 'Home') next = opts.min
    else if (event.key === 'End') next = opts.max
    else return
    event.preventDefault()
    cancelSettle?.()
    opts.size.value = clamp(next)
    opts.onCommit?.(opts.size.value)
  }

  onBeforeUnmount(() => {
    cancelSettle?.()
    if (rafId !== null) cancelAnimationFrame(rafId)
    window.removeEventListener('pointermove', onPointermove)
    document.body.classList.remove(resizingClass)
  })

  return {
    resizing,
    separatorProps: {
      role: 'separator',
      tabindex: 0,
      'aria-orientation': horizontal ? 'vertical' : 'horizontal',
      'aria-valuenow': computed(() => Math.round(opts.size.value)),
      'aria-valuemin': opts.min,
      'aria-valuemax': opts.max,
      onPointerdown,
      onKeydown,
    },
  }
}

/**
 * Apple's momentum projection (exponential-decay form, from Designing Fluid
 * Interfaces): how far a flick carries the panel past its release point.
 */
export function projectMomentum(
  initialVelocity: number,
  decelerationRate = 0.998,
): number {
  return ((initialVelocity / 1000) * decelerationRate) / (1 - decelerationRate)
}
