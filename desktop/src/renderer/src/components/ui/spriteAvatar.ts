/**
 * Sprite avatars (DS-04). A child agent's portrait is a measured window of
 * a 448px sheet (SUB-30). The window is cropped and scaled in one createImageBitmap
 * call to the device-pixel size the avatar is drawn at, then painted into a
 * canvas of exactly that size: the page never keeps the whole sheet on
 * screen or rescales it on every paint. Crops are shared per portrait and
 * size; a sheet is let go shortly after its last pending crop. Moving the
 * window to a screen with another pixel ratio redraws at the new size.
 */
import { ref } from 'vue'

export type SpriteRect = readonly [number, number, number, number]

export interface SpriteLayout {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 3% room on every side: the portraits have no tile any more (UI-S13), so
 * the character fills the box; ears and antennae stay inside.
 */
const CONTENT_PERCENT = 94

/** Fit the measured window into the content box, centred (aspect "meet"). */
export function portraitLayout(rect: SpriteRect, pixels: number): SpriteLayout {
  const box = (pixels * CONTENT_PERCENT) / 100
  const scale = Math.min(box / rect[2], box / rect[3])
  const width = Math.max(1, Math.round(rect[2] * scale))
  const height = Math.max(1, Math.round(rect[3] * scale))
  return {
    x: Math.round((pixels - width) / 2),
    y: Math.round((pixels - height) / 2),
    width,
    height,
  }
}

function currentRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1
}

/** Bumped when the window moves to a screen with another pixel ratio. */
const ratioChanges = ref(0)

function watchRatio(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return
  const query = window.matchMedia(`(resolution: ${currentRatio()}dppx)`)
  query.addEventListener?.(
    'change',
    () => {
      ratioChanges.value += 1
      watchRatio()
    },
    { once: true },
  )
}
watchRatio()

/** Device pixels for a CSS size on this screen (capped at 4×); reactive. */
export function spritePixels(size: number): number {
  void ratioChanges.value
  return Math.round(size * Math.min(currentRatio(), 4))
}

/** Canvas cropping needs createImageBitmap (absent in jsdom and old engines). */
export function spriteSupported(): boolean {
  return typeof createImageBitmap === 'function'
}

interface SheetEntry {
  image: Promise<HTMLImageElement>
  users: number
  timer?: ReturnType<typeof setTimeout>
}

const SHEET_LINGER_MS = 2000
const sheets = new Map<string, SheetEntry>()
const crops = new Map<string, Promise<ImageBitmap | null>>()

function acquireSheet(url: string): Promise<HTMLImageElement> {
  let entry = sheets.get(url)
  if (!entry) {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    entry = { image: image.decode().then(() => image), users: 0 }
    sheets.set(url, entry)
  }
  entry.users += 1
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = undefined
  return entry.image
}

function releaseSheet(url: string) {
  const entry = sheets.get(url)
  if (!entry) return
  entry.users -= 1
  if (entry.users > 0) return
  entry.timer = setTimeout(() => {
    if (sheets.get(url) === entry && entry.users <= 0) sheets.delete(url)
  }, SHEET_LINGER_MS)
}

/** The portrait cropped to `layout`'s size (shared; null when it fails). */
export function portraitBitmap(
  sheet: string,
  id: string,
  rect: SpriteRect,
  layout: SpriteLayout,
): Promise<ImageBitmap | null> {
  const key = `${id}@${layout.width}x${layout.height}`
  let pending = crops.get(key)
  if (!pending) {
    pending = acquireSheet(sheet)
      .then((image) =>
        createImageBitmap(image, rect[0], rect[1], rect[2], rect[3], {
          resizeWidth: layout.width,
          resizeHeight: layout.height,
          resizeQuality: 'high',
        }),
      )
      .catch(() => {
        crops.delete(key)
        return null
      })
      .finally(() => releaseSheet(sheet))
    crops.set(key, pending)
  }
  return pending
}

/** Tests: forget every decoded sheet and crop. */
export function clearSpriteCache(): void {
  for (const entry of sheets.values())
    if (entry.timer) clearTimeout(entry.timer)
  sheets.clear()
  crops.clear()
}
