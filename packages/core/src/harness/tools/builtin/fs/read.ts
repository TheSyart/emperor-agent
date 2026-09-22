/**
 * `read` tool (ported from dsh-tool-fs read.ts + read-render.ts): a bounded,
 * line-numbered window of a UTF-8 text file. One stat supplies type, size
 * routing (stream at/above 10 MiB) and the observed version recorded for
 * the read-before-edit policy.
 */

import { extname } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../definition'
import {
  FsError,
  probe,
  readWholeText,
  resolveTarget,
  streamWholeText,
} from './fsio'
import { sessionCwd, sessionIdOf, type FsToolState } from './shared'

/** Default and maximum number of lines returned by one call. */
export const READ_LIMIT = 2000
/** Maximum characters returned for a single line. */
export const READ_MAX_LINE_LENGTH = 2000
/** Maximum bytes returned for the selected lines. */
export const READ_MAX_BYTES = 50 * 1024
/** Files at or above this size stream instead of loading whole. */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

export interface FileTextLine {
  number: number
  text: string
}

export interface ReadWindow {
  offset: number
  limit: number
  maxLineLength: number
  maxBytes: number
}

export interface WindowResult {
  lines: FileTextLine[]
  totalLines: number
  truncatedByBytes: boolean
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength
    ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    : line
}

/**
 * Build one window from decoded chunks, enforcing line and byte caps while
 * still counting total lines exactly; an offset past EOF is `FS_NOT_FOUND`.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const lines: FileTextLine[] = []
  let totalLines = 0
  let outputBytes = 0
  let truncatedByBytes = false
  const lineBufferCap = request.maxLineLength + 1
  let lineBuffer = ''

  const append = (segment: string): void => {
    if (lineBuffer.length >= lineBufferCap) return
    lineBuffer += segment
    if (lineBuffer.length > lineBufferCap)
      lineBuffer = lineBuffer.slice(0, lineBufferCap)
  }
  const flush = (): void => {
    const raw = lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer
    lineBuffer = ''
    totalLines += 1
    if (
      truncatedByBytes ||
      totalLines < request.offset ||
      lines.length >= request.limit
    )
      return
    const text = truncateLine(raw, request.maxLineLength)
    const bytes = Buffer.byteLength(text, 'utf8') + (lines.length > 0 ? 1 : 0)
    if (outputBytes + bytes > request.maxBytes) {
      truncatedByBytes = true
      return
    }
    outputBytes += bytes
    lines.push({ number: totalLines, text })
  }

  for await (const chunk of chunks) {
    let start = 0
    let newline: number
    while ((newline = chunk.indexOf('\n', start)) !== -1) {
      append(chunk.slice(start, newline))
      flush()
      start = newline + 1
    }
    append(chunk.slice(start))
  }
  if (lineBuffer.length > 0) flush()
  if (
    !truncatedByBytes &&
    request.offset > totalLines &&
    !(totalLines === 0 && request.offset === 1)
  ) {
    throw new FsError(
      `offset ${request.offset} is out of range for "${displayPath}" (${totalLines} lines)`,
      'FS_NOT_FOUND',
    )
  }
  return { lines, totalLines, truncatedByBytes }
}

/** The model-facing read envelope (verbatim dsh format). */
export function formatReadOutput(
  displayPath: string,
  outcome: {
    offset: number
    lines: FileTextLine[]
    totalLines: number
    truncatedByBytes?: boolean
  },
): string {
  const endLine =
    outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes === true) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body =
    outcome.lines.length > 0
      ? `${outcome.lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
      : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}

/** Short text note for an image file (read returns text only). */
export function formatImageNote(
  displayPath: string,
  mediaType: string,
  bytes: number,
): string {
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${mediaType} image, ${bytes} bytes. The read tool returns text only; the image content is not included.
</content>`
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
  return value
}

/** Validate what the schema cannot express; defaults offset to 1 and limit to the cap. */
export function parseReadArgs(
  args: {
    file_path: string
    offset?: number | undefined
    limit?: number | undefined
  },
  maxLimit = READ_LIMIT,
): { filePath: string; offset: number; limit: number } {
  if (args.file_path.trim().length === 0)
    throw new Error('file_path must be a non-empty string')
  const offset =
    args.offset === undefined ? 1 : positiveInteger(args.offset, 'offset')
  const limit =
    args.limit === undefined ? maxLimit : positiveInteger(args.limit, 'limit')
  if (limit > maxLimit)
    throw new Error(`limit must be less than or equal to ${maxLimit}`)
  return { filePath: args.file_path, offset, limit }
}

const readInput = z.object({
  file_path: z
    .string()
    .describe(
      'Path to read: absolute, or relative to the session working directory.',
    ),
  offset: z
    .number()
    .optional()
    .describe('1-based first line to return. Defaults to 1.'),
  limit: z
    .number()
    .optional()
    .describe(`Maximum number of lines to return. Defaults to ${READ_LIMIT}.`),
})

export type ReadArgs = z.output<typeof readInput>

export function createReadTool(state: FsToolState): ToolDefinition<ReadArgs> {
  return defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    input: readInput,
    // Observation races fail closed: guarded mutations re-check the version in-lock.
    isConcurrencySafe: () => true,
    async execute(args, context) {
      const input = parseReadArgs(args)
      const target = await resolveTarget(
        sessionCwd(state, context, input.filePath),
        input.filePath,
      )
      const sessionId = sessionIdOf(context)
      const info = await probe(target.targetKey)
      if (info === null) {
        state.observations.observe(sessionId, target, { kind: 'absent' })
        throw new FsError(
          `cannot read "${target.displayPath}": not found`,
          'FS_NOT_FOUND',
        )
      }
      if (info.type !== 'file') {
        throw new FsError(
          `cannot read "${target.displayPath}": not a regular file`,
          'FS_NOT_REGULAR_FILE',
        )
      }
      const mediaType =
        IMAGE_MEDIA_TYPES[extname(target.displayPath).toLowerCase()]
      if (mediaType !== undefined) {
        state.observations.observe(sessionId, target, {
          kind: 'present',
          version: info.version,
        })
        return {
          content: formatImageNote(target.displayPath, mediaType, info.size),
          meta: { path: target.displayPath, mediaType, bytes: info.size },
        }
      }
      const chunks =
        info.size >= STREAM_MIN_SIZE
          ? streamWholeText(target, context.signal)
          : [await readWholeText(target, context.signal)]
      const window = await buildWindow(
        chunks,
        {
          offset: input.offset,
          limit: input.limit,
          maxLineLength: READ_MAX_LINE_LENGTH,
          maxBytes: READ_MAX_BYTES,
        },
        target.displayPath,
      )
      state.observations.observe(sessionId, target, {
        kind: 'present',
        version: info.version,
      })
      const endLine =
        window.lines.at(-1)?.number ?? Math.max(0, input.offset - 1)
      return {
        content: formatReadOutput(target.displayPath, {
          offset: input.offset,
          ...window,
        }),
        meta: {
          path: target.displayPath,
          startLine: input.offset,
          endLine,
          totalLines: window.totalLines,
        },
      }
    },
  })
}
