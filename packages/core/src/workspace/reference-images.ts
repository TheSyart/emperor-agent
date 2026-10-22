export function rasterMatches(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/x-icon' || mime === 'image/vnd.microsoft.icon')
    return validIco(bytes)
  if (mime === 'image/png')
    return (
      bytes.length >= 45 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      safeDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) &&
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND'
    )
  if (mime === 'image/jpeg') return validJpegFrame(bytes)
  if (mime === 'image/gif')
    return (
      bytes.length >= 14 &&
      ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) &&
      safeDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8)) &&
      bytes[bytes.length - 1] === 0x3b
    )
  if (mime === 'image/webp') return validWebpFrame(bytes)
  return false
}

function validIco(bytes: Buffer): boolean {
  if (
    bytes.length < 22 ||
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1
  )
    return false
  const count = bytes.readUInt16LE(4)
  if (!count || count > 64 || bytes.length < 6 + count * 16) return false
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    const size = bytes.readUInt32LE(entry + 8),
      offset = bytes.readUInt32LE(entry + 12)
    if (offset < 6 + count * 16 || !size || offset + size > bytes.length)
      return false
    const frame = bytes.subarray(offset, offset + size)
    if (rasterMatches(frame, 'image/png')) continue
    // ICO's other supported payload is a bounded, uncompressed Windows DIB.
    if (frame.length < 40 || frame.readUInt32LE(0) !== 40) return false
    const width = bytes[entry] || 256,
      height = bytes[entry + 1] || 256
    const bits = frame.readUInt16LE(14)
    if (
      frame.readInt32LE(4) !== width ||
      frame.readInt32LE(8) !== height * 2 ||
      frame.readUInt16LE(12) !== 1 ||
      ![1, 4, 8, 24, 32].includes(bits) ||
      frame.readUInt32LE(16) !== 0
    )
      return false
    const palette = bits <= 8 ? (frame.readUInt32LE(32) || 2 ** bits) * 4 : 0
    if (
      palette > 1024 ||
      frame.length < 40 + palette + Math.ceil((width * bits) / 32) * 4 * height
    )
      return false
  }
  return true
}

function safeDimensions(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= 8192 &&
    height <= 8192 &&
    width * height <= 16_777_216
  )
}

function validJpegFrame(bytes: Buffer): boolean {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  )
    return false
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return false
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    if (
      marker === undefined ||
      marker === 0xda ||
      marker === 0xd9 ||
      offset + 2 > bytes.length
    )
      return false
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length) return false
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    )
      return (
        size >= 8 &&
        safeDimensions(
          bytes.readUInt16BE(offset + 5),
          bytes.readUInt16BE(offset + 3),
        )
      )
    offset += size
  }
  return false
}

function validWebpFrame(bytes: Buffer): boolean {
  if (
    bytes.length < 25 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return false
  const kind = bytes.toString('ascii', 12, 16)
  const chunkSize = bytes.readUInt32LE(16)
  if (chunkSize + 20 > bytes.length) return false
  if (kind === 'VP8X' && chunkSize >= 10 && bytes.length >= 30)
    return safeDimensions(
      1 + bytes.readUIntLE(24, 3),
      1 + bytes.readUIntLE(27, 3),
    )
  if (kind === 'VP8L' && chunkSize >= 5 && bytes[20] === 0x2f)
    return safeDimensions(
      1 + (bytes.readUInt32LE(21) & 0x3fff),
      1 + ((bytes.readUInt32LE(21) >>> 14) & 0x3fff),
    )
  if (
    kind === 'VP8 ' &&
    chunkSize >= 10 &&
    bytes.length >= 30 &&
    bytes.toString('hex', 23, 26) === '9d012a'
  )
    return safeDimensions(
      bytes.readUInt16LE(26) & 0x3fff,
      bytes.readUInt16LE(28) & 0x3fff,
    )
  return false
}
