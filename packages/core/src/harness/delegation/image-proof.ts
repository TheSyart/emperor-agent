import { inflateSync } from 'node:zlib'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Only the managed native image directory; never all of CODEX_HOME. */
export function nativeGeneratedImageRoot(
  runtimeRoot: string,
  trustedRoot: string,
): string | undefined {
  try {
    const local = relative(resolve(trustedRoot), resolve(runtimeRoot))
    if (
      !local ||
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('..' + sep)
    )
      return
    const expectedRuntime = resolve(realpathSync(trustedRoot), local)
    if (realpathSync(runtimeRoot) !== expectedRuntime) return
    const expected = join(expectedRuntime, 'codex', 'generated_images')
    return realpathSync(expected) === expected ? expected : undefined
  } catch {
    return undefined
  }
}
function crc32(b: Buffer) {
  let crc = 0xffffffff
  for (const byte of b) {
    crc ^= byte
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
/** Bounded full PNG integrity and scanline validation, not a magic-byte probe. */
export function validPng(b: Buffer): boolean {
  try {
    if (
      b.length < 57 ||
      !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return false
    let offset = 8,
      width = 0,
      height = 0,
      depth = 0,
      color = 0,
      ended = false,
      sawIdat = false
    const data: Buffer[] = []
    while (offset + 12 <= b.length) {
      const size = b.readUInt32BE(offset),
        end = offset + 12 + size
      if (end > b.length || size > 32 * 1024 * 1024) return false
      const type = b.toString('ascii', offset + 4, offset + 8),
        payload = b.subarray(offset + 8, end - 4)
      if (crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4))
        return false
      if (offset === 8 && type !== 'IHDR') return false
      if (type === 'IHDR') {
        if (width || size !== 13) return false
        width = payload.readUInt32BE(0)
        height = payload.readUInt32BE(4)
        depth = payload[8]!
        color = payload[9]!
        if (
          !width ||
          !height ||
          width * height > 16 * 1024 * 1024 ||
          payload[10] !== 0 ||
          payload[11] !== 0 ||
          payload[12] !== 0
        )
          return false
      } else if (type === 'IDAT') {
        sawIdat = true
        data.push(payload)
      } else if (type === 'IEND') {
        if (size !== 0 || !sawIdat || end !== b.length) return false
        ended = true
        break
      } else if (/^[A-Z]/.test(type) && !['PLTE'].includes(type)) return false
      offset = end
    }
    const channels = (
      { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>
    )[color]
    if (
      !ended ||
      !channels ||
      ![1, 2, 4, 8, 16].includes(depth) ||
      ((color === 2 || color === 4 || color === 6) && depth < 8) ||
      (color === 3 && depth === 16)
    )
      return false
    const row = Math.ceil((width * channels * depth) / 8) + 1,
      expected = row * height
    if (expected > 128 * 1024 * 1024) return false
    const decoded = inflateSync(Buffer.concat(data), {
      maxOutputLength: expected + 1,
    })
    if (decoded.length !== expected) return false
    for (let y = 0; y < height; y++) if (decoded[y * row]! > 4) return false
    return true
  } catch {
    return false
  }
}
