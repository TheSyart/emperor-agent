/**
 * Helper protocol framing (spec 00 §11):
 *
 *   frame  = u32 big-endian length (of kind + body) · u8 kind · body
 *   kind 1 = JSON message, UTF-8, at most 1 MiB
 *   kind 2 = binary blob: u8 id length · ASCII blob id · bytes
 *
 * Blobs (screenshots) travel as their own frames right after the JSON
 * message that references them by `blobId`, so nothing is base64-inflated.
 * A frame larger than 32 MiB is a protocol error.
 */

export const FRAME_JSON = 1
export const FRAME_BLOB = 2
export const MAX_JSON_BYTES = 1024 * 1024
export const MAX_FRAME_BYTES = 32 * 1024 * 1024

export class FramingError extends Error {
  readonly code = 'PROTOCOL_FRAMING'
  constructor(message: string) {
    super(message)
    this.name = 'FramingError'
  }
}

export type DecodedFrame =
  | { readonly kind: 'json'; readonly value: unknown }
  | {
      readonly kind: 'blob'
      readonly blobId: string
      readonly bytes: Uint8Array
    }

const BLOB_ID = /^[A-Za-z0-9_-]{1,64}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function frame(kind: number, body: Uint8Array): Uint8Array {
  const length = body.byteLength + 1
  if (length > MAX_FRAME_BYTES)
    throw new FramingError(
      `frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}`,
    )
  const out = new Uint8Array(4 + length)
  new DataView(out.buffer).setUint32(0, length, false)
  out[4] = kind
  out.set(body, 5)
  return out
}

export function encodeJsonFrame(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message))
  if (body.byteLength > MAX_JSON_BYTES)
    throw new FramingError(
      `JSON message of ${body.byteLength} bytes exceeds ${MAX_JSON_BYTES}`,
    )
  return frame(FRAME_JSON, body)
}

export function encodeBlobFrame(blobId: string, bytes: Uint8Array): Uint8Array {
  if (!BLOB_ID.test(blobId)) throw new FramingError('invalid blob id')
  const id = encoder.encode(blobId)
  const body = new Uint8Array(1 + id.byteLength + bytes.byteLength)
  body[0] = id.byteLength
  body.set(id, 1)
  body.set(bytes, 1 + id.byteLength)
  return frame(FRAME_BLOB, body)
}

/**
 * Incremental decoder for a byte stream. `push` returns every complete frame
 * and keeps any partial tail; an oversized or malformed frame throws, after
 * which the stream must be dropped.
 */
export class FrameDecoder {
  /** Unconsumed chunks; assembled only once a whole frame has arrived. */
  private chunks: Uint8Array[] = []
  private total = 0
  private failed = false

  push(chunk: Uint8Array): DecodedFrame[] {
    if (this.failed) throw new FramingError('decoder already failed')
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk)
      this.total += chunk.byteLength
    }
    const frames: DecodedFrame[] = []
    try {
      for (;;) {
        if (this.total < 4) break
        const header = this.peek(4)
        const length = new DataView(
          header.buffer,
          header.byteOffset,
          4,
        ).getUint32(0, false)
        if (length < 1 || length > MAX_FRAME_BYTES)
          throw new FramingError(`frame length ${length} out of range`)
        if (this.total < 4 + length) break
        const whole = this.take(4 + length)
        frames.push(decodeBody(whole[4], whole.subarray(5)))
      }
    } catch (error) {
      this.failed = true
      this.chunks = []
      this.total = 0
      throw error
    }
    return frames
  }

  /** Bytes still waiting for the rest of a frame. */
  get pending(): number {
    return this.total
  }

  private peek(count: number): Uint8Array {
    const first = this.chunks[0]!
    if (first.byteLength >= count) return first.subarray(0, count)
    const out = new Uint8Array(count)
    let offset = 0
    for (const chunk of this.chunks) {
      const part = chunk.subarray(0, count - offset)
      out.set(part, offset)
      offset += part.byteLength
      if (offset === count) break
    }
    return out
  }

  private take(count: number): Uint8Array {
    const out = new Uint8Array(count)
    let offset = 0
    while (offset < count) {
      const chunk = this.chunks[0]!
      const need = count - offset
      if (chunk.byteLength <= need) {
        out.set(chunk, offset)
        offset += chunk.byteLength
        this.chunks.shift()
      } else {
        out.set(chunk.subarray(0, need), offset)
        this.chunks[0] = chunk.subarray(need)
        offset += need
      }
    }
    this.total -= count
    return out
  }
}

function decodeBody(kind: number | undefined, body: Uint8Array): DecodedFrame {
  if (kind === FRAME_JSON) {
    if (body.byteLength > MAX_JSON_BYTES)
      throw new FramingError(
        `JSON frame of ${body.byteLength} bytes exceeds ${MAX_JSON_BYTES}`,
      )
    let text: string
    try {
      text = decoder.decode(body)
    } catch {
      throw new FramingError('JSON frame is not valid UTF-8')
    }
    try {
      return { kind: 'json', value: JSON.parse(text) as unknown }
    } catch {
      throw new FramingError('JSON frame does not parse')
    }
  }
  if (kind === FRAME_BLOB) {
    const idLength = body[0] ?? 0
    const blobId = new TextDecoder().decode(body.subarray(1, 1 + idLength))
    if (
      idLength === 0 ||
      body.byteLength < 1 + idLength ||
      !BLOB_ID.test(blobId)
    )
      throw new FramingError('malformed blob frame')
    return { kind: 'blob', blobId, bytes: body.slice(1 + idLength) }
  }
  throw new FramingError(`unknown frame kind ${String(kind)}`)
}
