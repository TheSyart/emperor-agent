/** Settings-only deterministic crossfade. Task portraits never use this clock. */
export function sampleAvatarPreview(timeMs: number, count: number) {
  if (!Number.isFinite(timeMs) || !Number.isInteger(count) || count < 1)
    throw new TypeError('Invalid avatar preview timeline')
  const time = Math.max(0, timeMs),
    step = Math.floor(time / 2720)
  const progress = Math.max(0, Math.min(1, ((time % 2720) - 2400) / 320))
  const mix = progress * progress * (3 - 2 * progress)
  return {
    current: step % count,
    next: (step + 1) % count,
    mix,
    currentScale: 1 - 0.06 * mix,
    nextScale: 0.94 + 0.06 * mix,
  }
}
export type AvatarPreviewPose = ReturnType<typeof sampleAvatarPreview>
export function createAvatarPreviewPlayer(options: {
  count: number
  decode: () => Promise<unknown>
  paint: (pose: AvatarPreviewPose, staticOnly: boolean) => void
  request: (callback: (time: number) => void) => number
  cancel: (id: number) => void
  hidden?: boolean
  reduced?: boolean
  failed?: () => void
}) {
  sampleAvatarPreview(0, options.count)
  let elapsed = 0,
    last: number | null = null,
    raf: number | null = null,
    hidden = options.hidden ?? false,
    reduced = options.reduced ?? false,
    decoded = false,
    destroyed = false
  const paint = () =>
    options.paint(
      sampleAvatarPreview(elapsed, options.count),
      reduced || !decoded,
    )
  const canPlay = () => decoded && !destroyed && !hidden && !reduced
  function cancel() {
    if (raf !== null) options.cancel(raf)
    raf = null
    last = null
  }
  function tick(now: number) {
    raf = null
    if (!canPlay()) return
    if (last !== null) elapsed += Math.max(0, now - last)
    last = now
    paint()
    raf = options.request(tick)
  }
  function sync() {
    if (destroyed) return
    if (!canPlay()) cancel()
    else if (raf === null) {
      last = null
      raf = options.request(tick)
    }
    paint()
  }
  paint()
  const ready = Promise.resolve()
    .then(() => options.decode())
    .then(() => {
      if (!destroyed) {
        decoded = true
        sync()
      }
    })
    .catch(() => {
      if (!destroyed) {
        paint()
        options.failed?.()
      }
    })
  return {
    ready,
    getTime: () => elapsed,
    setHidden(value: boolean) {
      hidden = value
      sync()
    },
    setReducedMotion(value: boolean) {
      reduced = value
      sync()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      cancel()
    },
  }
}
