/** Screenshot image handling with Electron's `nativeImage` (spec 00 §8.5). */

import { nativeImage } from 'electron'
import type { ImageCodec } from './embedded-browser-driver'

export const nativeImageCodec: ImageCodec = {
  size(png) {
    return nativeImage.createFromBuffer(Buffer.from(png)).getSize()
  },
  jpegCopy(png, maxEdge) {
    let image = nativeImage.createFromBuffer(Buffer.from(png))
    const { width, height } = image.getSize()
    const longest = Math.max(width, height)
    if (longest > maxEdge) {
      const ratio = maxEdge / longest
      image = image.resize({
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(height * ratio)),
        quality: 'good',
      })
    }
    const size = image.getSize()
    return {
      jpeg: Uint8Array.from(image.toJPEG(80)),
      width: size.width,
      height: size.height,
    }
  },
}
