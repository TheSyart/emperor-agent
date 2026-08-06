import { describe, it, expect } from 'vitest'
import { animateSpring, SPRING } from './useSpring'

// Drive the spring by injecting a manual scheduler that queues callbacks and
// advances a fixed 16.67ms clock, so tests are deterministic and need no rAF.

class ManualDriver {
  now = 0
  private pending: Array<(now: number) => void> = []

  /** Matches the schedule seam: (cb) => cancel. */
  schedule = (cb: (now: number) => void): (() => void) => {
    this.pending.push(cb)
    return () => {
      this.pending = this.pending.filter((entry) => entry !== cb)
    }
  }
  /** Advance one frame; returns false when nothing is scheduled. */
  tick(step = 1000 / 60): boolean {
    const batch = this.pending.splice(0)
    if (batch.length === 0) return false
    this.now += step
    for (const cb of batch) cb(this.now)
    return true
  }
  /** Run until the loop quiesces (or a safety cap). */
  run(capFrames = 600): void {
    let frames = 0
    while (this.tick() && frames < capFrames) frames++
  }
  get active(): number {
    return this.pending.length
  }
}

function collect(
  driver: ManualDriver,
  from: number,
  to: number,
  opts?: Partial<Parameters<typeof animateSpring>[2]>,
) {
  const values: number[] = []
  let rested = false
  const cancel = animateSpring(from, to, {
    ...opts,
    schedule: driver.schedule,
    onUpdate: (v) => values.push(v),
    onRest: () => {
      rested = true
    },
  })
  return { values, cancel, isRested: () => rested }
}

describe('animateSpring', () => {
  it('settles exactly on the target and calls onRest once', () => {
    const d = new ManualDriver()
    const run = collect(d, 0, 100, { params: 'snappy' })
    d.run()
    expect(run.values[run.values.length - 1]).toBe(100)
    expect(run.isRested()).toBe(true)
    expect(d.active).toBe(0)
  })

  it('critically-damped presets do not overshoot the target', () => {
    for (const preset of ['gentle', 'snappy'] as const) {
      const d = new ManualDriver()
      const run = collect(d, 0, 100, { params: SPRING[preset] })
      d.run()
      const max = Math.max(...run.values)
      expect(max, `${preset} must not overshoot`).toBeLessThanOrEqual(
        100 + 1e-6,
      )
    }
  })

  it('bouncy preset overshoots the target at least once', () => {
    const d = new ManualDriver()
    const run = collect(d, 0, 100, { params: SPRING.bouncy })
    d.run()
    expect(Math.max(...run.values)).toBeGreaterThan(100)
    expect(run.values[run.values.length - 1]).toBe(100)
  })

  it('monotonically approaches under gentle (no oscillation)', () => {
    const d = new ManualDriver()
    const run = collect(d, 0, 100, { params: SPRING.gentle })
    d.run()
    for (let i = 1; i < run.values.length; i++) {
      expect(run.values[i]!).toBeGreaterThanOrEqual(run.values[i - 1]!)
    }
  })

  it('honours an initial velocity handoff (moves early, still settles)', () => {
    const d = new ManualDriver()
    const run = collect(d, 50, 100, { params: 'snappy', velocity: 400 })
    d.tick()
    d.tick()
    expect(run.values[run.values.length - 1]! - 50).toBeGreaterThan(0)
    d.run()
    expect(run.values[run.values.length - 1]).toBe(100)
  })

  it('cancel stops the loop without snapping or further updates', () => {
    const d = new ManualDriver()
    const run = collect(d, 0, 100, { params: 'snappy' })
    d.tick()
    d.tick()
    const before = run.values.length
    run.cancel()
    d.tick()
    d.tick()
    expect(run.values.length).toBe(before) // no further onUpdate
    expect(d.active).toBe(0) // no leaked frame
    expect(run.isRested()).toBe(false) // did not report rest
  })

  it('returns to rest immediately when from === to', () => {
    const d = new ManualDriver()
    const run = collect(d, 42, 42, { params: 'snappy' })
    expect(run.values).toEqual([42])
    expect(run.isRested()).toBe(true)
    expect(d.active).toBe(0)
  })

  it('stays finite across a zero-length first frame', () => {
    const d = new ManualDriver()
    const run = collect(d, 0, 100, { params: 'snappy' })
    d.tick(0) // dt clamp path
    d.run()
    expect(run.values[run.values.length - 1]).toBe(100)
    for (const v of run.values) expect(Number.isFinite(v)).toBe(true)
  })
})
