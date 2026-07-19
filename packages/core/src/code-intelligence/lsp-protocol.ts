const DEFAULT_MAX_HEADER_BYTES = 8 * 1024
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'ascii')

export interface LspContentLengthDecoderOptions {
  maxHeaderBytes?: number
  maxBodyBytes?: number
}

/** Strict, bounded decoder for the LSP stdio Content-Length framing format. */
export class LspContentLengthDecoder {
  private readonly maxHeaderBytes: number
  private readonly maxBodyBytes: number
  private buffered = Buffer.alloc(0)
  private expectedBodyBytes: number | null = null
  private failed = false

  constructor(opts: LspContentLengthDecoderOptions = {}) {
    this.maxHeaderBytes = boundedLimit(
      opts.maxHeaderBytes,
      DEFAULT_MAX_HEADER_BYTES,
    )
    this.maxBodyBytes = boundedLimit(opts.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)
  }

  append(chunk: Buffer | string): unknown[] {
    if (this.failed)
      throw new Error('LSP decoder is closed after protocol error')
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.length > 0) this.buffered = Buffer.concat([this.buffered, bytes])
    const messages: unknown[] = []
    try {
      while (true) {
        if (this.expectedBodyBytes === null) {
          const headerEnd = this.buffered.indexOf(HEADER_TERMINATOR)
          if (headerEnd < 0) {
            if (this.buffered.length > this.maxHeaderBytes)
              throw new Error('LSP protocol header exceeds byte limit')
            return messages
          }
          if (headerEnd > this.maxHeaderBytes)
            throw new Error('LSP protocol header exceeds byte limit')
          const header = this.buffered.subarray(0, headerEnd).toString('ascii')
          this.expectedBodyBytes = parseContentLength(header, this.maxBodyBytes)
          this.buffered = this.buffered.subarray(
            headerEnd + HEADER_TERMINATOR.length,
          )
        }

        if (this.buffered.length < this.expectedBodyBytes) return messages
        const body = this.buffered.subarray(0, this.expectedBodyBytes)
        this.buffered = this.buffered.subarray(this.expectedBodyBytes)
        this.expectedBodyBytes = null
        let message: unknown
        try {
          message = JSON.parse(body.toString('utf8'))
        } catch {
          throw new Error('LSP protocol body is not valid JSON')
        }
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new Error('LSP protocol JSON message must be an object')
        messages.push(message)
      }
    } catch (error) {
      this.failed = true
      this.buffered = Buffer.alloc(0)
      this.expectedBodyBytes = null
      throw error
    }
  }
}

export function encodeLspMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

function parseContentLength(header: string, maxBodyBytes: number): number {
  const values: string[] = []
  for (const line of header.split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    if (line.slice(0, separator).trim().toLowerCase() !== 'content-length')
      continue
    values.push(line.slice(separator + 1).trim())
  }
  if (values.length !== 1)
    throw new Error('LSP protocol requires exactly one Content-Length header')
  const raw = values[0]!
  if (!/^[0-9]+$/.test(raw))
    throw new Error('LSP protocol Content-Length must be a decimal integer')
  const length = Number(raw)
  if (!Number.isSafeInteger(length))
    throw new Error('LSP protocol Content-Length is outside the safe range')
  if (length > maxBodyBytes)
    throw new Error('LSP protocol body exceeds byte limit')
  return length
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fallback
  return Number(value)
}
