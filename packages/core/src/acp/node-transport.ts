import type { Readable, Writable } from 'node:stream'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'

export const DEFAULT_ACP_MAX_LINE_BYTES = 8 * 1024 * 1024

export interface BoundedNodeAcpStreamOptions {
  maxLineBytes?: number
}

export function createBoundedNodeAcpStream(
  input: Readable,
  output: Writable,
  opts: BoundedNodeAcpStreamOptions = {},
): Stream {
  const maxLineBytes = positiveInteger(
    opts.maxLineBytes ?? DEFAULT_ACP_MAX_LINE_BYTES,
    'maxLineBytes',
  )
  let cancelled = false
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      void consumeInput(input, maxLineBytes, controller, () => cancelled)
    },
    cancel(reason) {
      cancelled = true
      if (!input.destroyed) input.destroy(asError(reason, 'ACP input cancelled'))
    },
  })
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const line = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
      if (line.byteLength > maxLineBytes) {
        throw new Error(`ACP output line exceeds ${maxLineBytes} bytes`)
      }
      await writeNode(output, line)
    },
    abort(reason) {
      if (!output.destroyed)
        output.destroy(asError(reason, 'ACP output aborted'))
    },
  })
  return { readable, writable }
}

async function consumeInput(
  input: Readable,
  maxLineBytes: number,
  controller: ReadableStreamDefaultController<AnyMessage>,
  cancelled: () => boolean,
): Promise<void> {
  let pending = Buffer.alloc(0)
  try {
    for await (const raw of input) {
      if (cancelled()) return
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      let offset = 0
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, offset)
        const end = newline < 0 ? chunk.byteLength : newline
        const part = chunk.subarray(offset, end)
        if (pending.byteLength + part.byteLength > maxLineBytes) {
          throw new Error(`ACP line exceeds ${maxLineBytes} bytes`)
        }
        if (part.byteLength) pending = Buffer.concat([pending, part])
        if (newline < 0) break
        enqueueLine(controller, pending)
        pending = Buffer.alloc(0)
        offset = newline + 1
      }
    }
    if (!cancelled() && pending.byteLength) enqueueLine(controller, pending)
    if (!cancelled()) controller.close()
  } catch (error) {
    if (!cancelled()) controller.error(error)
  }
}

function enqueueLine(
  controller: ReadableStreamDefaultController<AnyMessage>,
  bytes: Buffer,
): void {
  const withoutCr =
    bytes.at(-1) === 0x0d ? bytes.subarray(0, bytes.byteLength - 1) : bytes
  if (!withoutCr.byteLength) return
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(withoutCr)
  } catch {
    throw new Error('invalid ACP UTF-8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('invalid ACP JSON')
  }
  if (!isRecord(parsed)) throw new Error('ACP message must be an object')
  controller.enqueue(parsed as AnyMessage)
}

async function writeNode(output: Writable, content: Buffer): Promise<void> {
  if (output.destroyed || !output.writable)
    throw new Error('ACP output is closed')
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    const onError = (error: Error): void => finish(error)
    // A Writable whose _write callback fails also emits `error`. Keep a
    // listener for both paths so EPIPE cannot escape as an uncaught exception.
    output.once('error', onError)
    output.write(content, (error) => {
      if (!error) output.off('error', onError)
      finish(error)
    })
  })
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback)
}
