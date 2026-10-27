/**
 * A skin picture's type and size from its first bytes (BRD-05). Only PNG
 * and WebP; the file name is never trusted, and the header's width and
 * height bound what the renderer would decode.
 */

export type SkinImageType = 'png' | 'webp'

export interface SkinImageInfo {
  type: SkinImageType
  width: number
  height: number
}

/** Bytes enough for both headers. */
export const SKIN_IMAGE_HEAD_BYTES = 32

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length))
}

function u16le(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8)
}

function u24le(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
}

function u32be(b: Uint8Array, at: number): number {
  return (
    ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!
  )
}

function u32le(b: Uint8Array, at: number): number {
  return (
    (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) +
    ((b[at + 3]! << 24) >>> 0)
  )
}

function valid(info: SkinImageInfo): SkinImageInfo | null {
  return info.width > 0 && info.height > 0 ? info : null
}

export function sniffImage(bytes: Uint8Array): SkinImageInfo | null {
  if (
    bytes.length >= 24 &&
    PNG.every((value, index) => bytes[index] === value)
  ) {
    if (ascii(bytes, 12, 4) !== 'IHDR') return null
    return valid({
      type: 'png',
      width: u32be(bytes, 16),
      height: u32be(bytes, 20),
    })
  }
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'WEBP'
  )
    return null
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X')
    return valid({
      type: 'webp',
      width: u24le(bytes, 24) + 1,
      height: u24le(bytes, 27) + 1,
    })
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null
    const bits = u32le(bytes, 21)
    return valid({
      type: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    })
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return null
    return valid({
      type: 'webp',
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
    })
  }
  return null
}

export function imageMime(type: SkinImageType): 'image/png' | 'image/webp' {
  return type === 'png' ? 'image/png' : 'image/webp'
}
