/**
 * Oversized tool-result spill (ported from dsh-spill-policy + dsh-spill-local,
 * without the Cordis service seam).
 *
 * {@link createSpillMiddleware} is a post-execute middleware: when an accepted
 * plain-text result exceeds `maxInlineBytes` (UTF-8), the FULL text is saved to
 * a private, unpredictably named file under `root` and the model-facing
 * content becomes a head/tail preview plus a notice carrying the file path.
 * The replacement is guaranteed to fit under the cap; when it cannot (a tiny
 * cap or a very long root), the original result is kept.
 *
 * Deliberately narrow, as in dsh:
 * - error results and results carrying any non-text block pass untouched;
 * - `read` is excluded by default to avoid a read → spill → read-again loop;
 * - best-effort: a storage failure never turns a successful call into an
 *   error or hides its content — the original is kept.
 *
 * Push it LAST onto `ToolRegistry.postExecute` so it bounds whatever earlier
 * middleware accepted (the dsh policy delegates first, then bounds).
 *
 * {@link spillText} is the storage half, for tools that spill internally
 * (e.g. `grep`/`glob` saving their complete over-cap result).
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ContentBlock } from '../../llm/types'
import type { PostExecuteMiddleware } from './registry'

/** Retrieval guidance appended after a spill locator (dsh-spill-local wording). */
export const SPILL_RETRIEVAL_HINT =
  'Use read with offset/limit, or grep this path to search within it.'

/** Default model-facing cap for one plain-text tool result, in UTF-8 bytes. */
export const DEFAULT_MAX_INLINE_BYTES = 50_000

/** A saved spill file. */
export interface SpillRef {
  /** Absolute path of the saved file (the model-facing locator). */
  path: string
  /** UTF-8 byte length of the saved text. */
  bytes: number
  /** Retrieval guidance for the model. */
  retrievalHint: string
}

export interface SpillTextOptions {
  /** Owning session; files land under `<root>/session-<hash>/` when given. */
  sessionId?: string
}

/**
 * Encode an arbitrary string as one safe path segment (injective; neutralizes
 * `../`, separators, NUL). Mirrors dsh-spill-local `encodeSegment`.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

/**
 * Save `text` to a fresh file under `root` and return its reference. The
 * filename is a random hex prefix plus the sanitized `label`, written
 * exclusively (`wx`) and owner-only (0600) inside a 0700 directory, so a
 * pre-planted path or symlink cannot redirect the write.
 */
export async function spillText(
  root: string,
  text: string,
  label: string,
  options: SpillTextOptions = {},
): Promise<SpillRef> {
  const base = resolve(root)
  const dir =
    options.sessionId === undefined ? base : sessionDir(base, options.sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(
    dir,
    `${randomBytes(6).toString('hex')}-${encodeSegment(label)}`,
  )
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
  } finally {
    await handle.close()
  }
  return {
    path,
    bytes: Buffer.byteLength(text, 'utf8'),
    retrievalHint: SPILL_RETRIEVAL_HINT,
  }
}

/** Drop a trailing incomplete UTF-8 sequence so a prefix cut never splits a codepoint. */
function trimTrailingPartialUtf8(bytes: Uint8Array): Uint8Array {
  let i = bytes.length - 1
  while (
    i >= 0 &&
    ((bytes[i] as number) & 0xc0) === 0x80 &&
    bytes.length - i <= 3
  )
    i--
  if (i < 0) return bytes
  const lead = bytes[i] as number
  const expected =
    lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0
  if (expected === 0) return bytes
  return bytes.length - i < expected ? bytes.subarray(0, i) : bytes
}

/** Drop leading continuation bytes so a suffix cut starts on a codepoint boundary. */
function trimLeadingContinuationUtf8(bytes: Uint8Array): Uint8Array {
  let i = 0
  while (i < bytes.length && ((bytes[i] as number) & 0xc0) === 0x80) i++
  return bytes.subarray(i)
}

const decoder = new TextDecoder()

/**
 * Keep at most `maxBytes` leading UTF-8 bytes of `text` (codepoint-safe).
 * @returns the kept text and whether anything was cut.
 */
export function utf8Head(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  return {
    text: decoder.decode(trimTrailingPartialUtf8(bytes.subarray(0, maxBytes))),
    truncated: true,
  }
}

/**
 * Head/tail preview of `text` within `budget` bytes, split ceil/floor across
 * the two ends (dsh `TextRetainer` `headTail`), with the exact omitted count.
 */
export function headTailPreview(
  text: string,
  budget: number,
): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(text, 'utf8')
  const headBytes = Math.ceil(budget / 2)
  const tailBytes = Math.floor(budget / 2)
  if (bytes.length <= headBytes + tailBytes) return { text, omittedBytes: 0 }
  const prefix = trimTrailingPartialUtf8(bytes.subarray(0, headBytes))
  const suffix = trimLeadingContinuationUtf8(
    bytes.subarray(bytes.length - tailBytes),
  )
  return {
    text: decoder.decode(prefix) + decoder.decode(suffix),
    omittedBytes: bytes.length - prefix.length - suffix.length,
  }
}

/** The spill-notice line (dsh-spill-policy wording). */
export function spillNotice(
  omittedBytes: number,
  ref: Pick<SpillRef, 'path' | 'retrievalHint'>,
): string {
  const omission = omittedBytes > 0 ? `Omitted ${omittedBytes} bytes.` : ''
  return `(${omission} Full formatted result stored at: ${ref.path}. ${ref.retrievalHint})`
}

/**
 * Build the within-cap replacement for `text` given a saved reference, or
 * `undefined` when no replacement fits under `cap`. The notice's cost is
 * reserved inside the cap, priced at the worst-case omission count (the full
 * byte total), so the final notice is never longer than what was reserved.
 */
export function spillReplacement(
  text: string,
  ref: SpillRef,
  cap: number,
): string | undefined {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  const reserve = Buffer.byteLength(spillNotice(totalBytes, ref), 'utf8') + 2
  const previewBudget = Math.max(0, cap - reserve)
  const preview = headTailPreview(text, previewBudget)
  const notice = spillNotice(preview.omittedBytes, ref)
  const replaced =
    preview.text.length > 0 ? `${preview.text}\n\n${notice}` : notice
  return Buffer.byteLength(replaced, 'utf8') > cap ? undefined : replaced
}

/** All-text content flattened to one string, or `undefined` if any block is non-text. */
function flattenPlainText(
  content: readonly ContentBlock[],
): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return undefined
    text += block.text
  }
  return text
}

export interface SpillMiddlewareOptions {
  /** Directory for spill files (created on demand). */
  root: string
  /** Model-facing cap for one plain-text result, in UTF-8 bytes (default 50000). */
  maxInlineBytes?: number
  /** Tool names never spilled (default `['read']`). */
  exclude?: readonly string[]
  /** Called when a spill is skipped because storage failed or no replacement fits. */
  onSkip?: (toolName: string, reason: string) => void
}

/** Create the oversized-result spill post-execute middleware. */
export function createSpillMiddleware(
  options: SpillMiddlewareOptions,
): PostExecuteMiddleware {
  const cap = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(
      `spill: maxInlineBytes must be a non-negative integer (got ${cap})`,
    )
  }
  const exclude = new Set(options.exclude ?? ['read'])
  return async (call, result) => {
    if (result.isError || exclude.has(call.name)) return undefined
    const text = flattenPlainText(result.content)
    if (text === undefined || Buffer.byteLength(text, 'utf8') <= cap)
      return undefined
    let ref: SpillRef
    try {
      const sessionId = call.agent?.session.header.id
      ref = await spillText(
        options.root,
        text,
        `${call.name}.txt`,
        sessionId === undefined ? {} : { sessionId },
      )
    } catch (error: unknown) {
      options.onSkip?.(call.name, `save failed: ${String(error)}`)
      return undefined
    }
    const replaced = spillReplacement(text, ref, cap)
    if (replaced === undefined) {
      options.onSkip?.(call.name, 'spill notice exceeds maxInlineBytes')
      return undefined
    }
    return { kind: 'accept', content: [{ type: 'text', text: replaced }] }
  }
}
