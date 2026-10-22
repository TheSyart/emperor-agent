/**
 * Pixel size from an image header (PNG, GIF, JPEG, WebP), so a stored
 * attachment can be priced in tokens by the route that sees it (KRN-05).
 * Reads only the header; returns null for anything it does not recognize.
 */

export interface ImageSize {
  width: number
  height: number
}

function size(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false
  for (let index = 0; index < text.length; index += 1)
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  return true
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  )
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function png(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || !ascii(bytes, 12, 'IHDR')) return null
  return size(u32be(bytes, 16), u32be(bytes, 20))
}

function gif(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null
  return size(u16le(bytes, 6), u16le(bytes, 8))
}

/** Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) do not. */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  )
}

function jpeg(bytes: Uint8Array): ImageSize | null {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2
      continue
    }
    const length = u16be(bytes, offset + 2)
    if (length < 2) return null
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) return null
      return size(u16be(bytes, offset + 7), u16be(bytes, offset + 5))
    }
    offset += 2 + length
  }
  return null
}

function webp(bytes: Uint8Array): ImageSize | null {
  if (ascii(bytes, 12, 'VP8X')) {
    if (bytes.length < 30) return null
    return size(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1)
  }
  if (ascii(bytes, 12, 'VP8L')) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null
    const bits =
      bytes[21]! |
      (bytes[22]! << 8) |
      (bytes[23]! << 16) |
      ((bytes[24]! << 24) >>> 0)
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (ascii(bytes, 12, 'VP8 ')) {
    // Key frame: 3-byte tag, start code 9d 01 2a, then 14-bit sizes.
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01)
      return null
    return size(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff)
  }
  return null
}

/** Pixel size read from the image header, or null. */
export function imageDimensions(bytes: Uint8Array): ImageSize | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG'))
    return png(bytes)
  if (ascii(bytes, 0, 'GIF8')) return gif(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return jpeg(bytes)
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return webp(bytes)
  return null
}
