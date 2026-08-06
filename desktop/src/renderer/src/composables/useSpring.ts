import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { prefersReducedMotion } from './useReducedMotion'

// Zero-dependency spring physics. A single hand-tuned parameter set lives here
// (mirrored by the --ease-* / --duration-* CSS motion tokens) so the whole app
// shares one motion feel. Springs are inherently interruptible and velocity-
// aware: re-targeting keeps the current value + velocity, so a user reversing a
// gesture mid-flight never hits a velocity "brick wall".

export interface SpringParams {
  /** Stiffness (spring constant k). Higher = snappier. */
  stiffness: number
  /** Damping (c). Higher = less oscillation. */
  damping: number
  /** Mass. Defaults to 1. */
  mass?: number
  /** Settle threshold in units + units/s. Defaults to a sub-pixel precision. */
  precision?: number
}

/**
 * Presets, expressed in the Apple damping/response mental model:
 * - gentle / snappy ≈ damping-ratio 1.0 (critically damped, no overshoot) — the
 *   default for almost all UI.
 * - bouncy ≈ 0.8 (slight overshoot) — only for momentum-driven interactions
 *   (a flick, a throw), never for a menu that merely faded in.
 */
export const SPRING = {
  gentle: { stiffness: 180, damping: 26 },
  snappy: { stiffness: 260, damping: 30 },
  bouncy: { stiffness: 220, damping: 18 },
} as const satisfies Record<string, SpringParams>

export type SpringPreset = keyof typeof SPRING

interface SpringState {
  value: number
  velocity: number
}

export interface AnimateSpringOptions {
  /** Initial velocity in units/second (hand off a gesture's release velocity). */
  velocity?: number
  params?: SpringPreset | Partial<SpringParams>
  onUpdate: (value: number) => void
  onRest?: () => void
  /** Clock/scheduler seam — tests inject a manual driver; default uses rAF. */
  schedule?: (cb: (now: number) => void) => () => void
}

// Default scheduler: requestAnimationFrame, wrapped as (cb) => cancel.
function defaultSchedule(cb: (now: number) => void): () => void {
  const id = requestAnimationFrame(cb)
  return () => cancelAnimationFrame(id)
}

/**
 * Imperative spring driver for a scalar. Animates `from` → `to`, calling
 * `onUpdate` each frame with the live value and `onRest` once settled. Returns
 * a cancel function; cancelling mid-flight stops the loop cleanly (no further
 * onUpdate calls) without snapping.
 *
 * Under prefers-reduced-motion the value jumps straight to `to` (single
 * onUpdate + onRest) — feedback without vestibular motion.
 */
export function animateSpring(
  from: number,
  to: number,
  opts: AnimateSpringOptions,
): () => void {
  const params = resolveParams(opts.params)
  const precision = params.precision ?? 0.1

  if (prefersReducedMotion() || from === to) {
    opts.onUpdate(to)
    opts.onRest?.()
    return () => {}
  }

  const schedule = opts.schedule ?? defaultSchedule
  const state: SpringState = { value: from, velocity: opts.velocity ?? 0 }
  let cancelFrame: (() => void) | null = null
  let last: number | null = null
  let cancelled = false

  const step = (now: number) => {
    if (cancelled) return
    if (last === null) last = now
    // Clamp dt so a backgrounded tab doesn't explode the integrator on resume.
    const dt = Math.min((now - last) / 1000, 0.064)
    last = now

    // Semi-implicit (symplectic) Euler: stable across the stiffness range we use.
    const displacement = state.value - to
    const springForce = -params.stiffness * displacement
    const dampingForce = -params.damping * state.velocity
    const mass = params.mass ?? 1
    const acceleration = (springForce + dampingForce) / mass

    state.velocity += acceleration * dt
    state.value += state.velocity * dt

    const settled =
      Math.abs(state.value - to) < precision &&
      Math.abs(state.velocity) < precision
    if (settled) {
      state.value = to
      state.velocity = 0
      opts.onUpdate(state.value)
      opts.onRest?.()
      return
    }
    opts.onUpdate(state.value)
    cancelFrame = schedule(step)
  }

  cancelFrame = schedule(step)
  return () => {
    if (cancelled) return
    cancelled = true
    cancelFrame?.()
  }
}

function resolveParams(
  input: SpringPreset | Partial<SpringParams> | undefined,
): Required<SpringParams> {
  const base: Required<SpringParams> = {
    ...SPRING.gentle,
    mass: 1,
    precision: 0.1,
  }
  if (!input) return base
  if (typeof input === 'string') return { ...base, ...SPRING[input] }
  return { ...base, ...input }
}

/**
 * Reactive spring: returns a ref that continuously follows `target`. When
 * `target` changes, the spring re-targets from its current value *and* current
 * velocity (velocity handoff), so rapid successive changes stay smooth.
 */
export function useSpring(
  target: Ref<number>,
  params?: SpringPreset | Partial<SpringParams>,
): Ref<number> {
  const value = ref(target.value)
  const state: SpringState = { value: target.value, velocity: 0 }
  let cancel: (() => void) | null = null

  const stop = () => {
    cancel?.()
    cancel = null
  }

  watch(
    target,
    (next) => {
      stop()
      if (prefersReducedMotion()) {
        state.value = next
        state.velocity = 0
        value.value = next
        return
      }
      let last = state.value
      let lastAt = performance.now()
      cancel = animateSpring(state.value, next, {
        params,
        velocity: state.velocity,
        onUpdate: (v) => {
          // Derive live velocity so an interruption hands off the real rate.
          const now = performance.now()
          const dt = (now - lastAt) / 1000
          if (dt > 0) state.velocity = (v - last) / dt
          last = v
          lastAt = now
          state.value = v
          value.value = v
        },
        onRest: () => {
          state.velocity = 0
        },
      })
    },
    { flush: 'sync' },
  )

  onBeforeUnmount(stop)
  return value
}
