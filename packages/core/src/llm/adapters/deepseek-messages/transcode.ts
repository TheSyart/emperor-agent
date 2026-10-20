/**
 * JPEG re-encoding for Files API uploads (KRN-07). DeepSeek resizes every
 * image to about 1300×1300 pixels before inference
 * (https://api-docs.deepseek.com/guides/vision), so a larger image is
 * scaled to that budget and encoded as JPEG before it is uploaded; the
 * caller tries qualities 85, 75 and 60 in turn.
 *
 * Core runs on macOS only and has no image library, so the encoder is the
 * system's `/usr/bin/sips` working on a private temporary directory.
 * Transparent areas become white.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ImageTranscoder {
  /**
   * Encode `input` as JPEG at `quality` (1–100), resized to exactly
   * `width`×`height` when both are given. Rejects when it cannot.
   */
  toJpeg(
    input: { data: Uint8Array; mediaType: string },
    target: { quality: number; width?: number; height?: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>
}

/** Aspect-preserving integer size within `maxPixels`; never enlarges. */
export function fitPixels(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  if (width * height <= maxPixels) return { width, height }
  const scale = Math.sqrt(maxPixels / (width * height))
  let fitWidth = Math.max(1, Math.floor(width * scale))
  let fitHeight = Math.max(1, Math.floor(height * scale))
  while (fitWidth * fitHeight > maxPixels) {
    if (fitWidth >= fitHeight && fitWidth > 1) fitWidth -= 1
    else if (fitHeight > 1) fitHeight -= 1
    else break
  }
  return { width: fitWidth, height: fitHeight }
}

const SIPS = '/usr/bin/sips'
const SIPS_TIMEOUT_MS = 30_000
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function run(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      SIPS,
      args,
      {
        timeout: SIPS_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      },
      (error) => {
        if (error) reject(error)
        else resolve()
      },
    )
  })
}

class SipsTranscoder implements ImageTranscoder {
  async toJpeg(
    input: { data: Uint8Array; mediaType: string },
    target: { quality: number; width?: number; height?: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const directory = await mkdtemp(join(tmpdir(), 'emperor-jpeg-'))
    try {
      const source = join(
        directory,
        `in.${EXTENSIONS[input.mediaType] ?? 'img'}`,
      )
      const output = join(directory, 'out.jpg')
      await writeFile(source, input.data, { mode: 0o600 })
      const quality = Math.min(100, Math.max(1, Math.round(target.quality)))
      await run(
        [
          '-s',
          'format',
          'jpeg',
          '-s',
          'formatOptions',
          String(quality),
          ...(target.width !== undefined && target.height !== undefined
            ? ['-z', String(target.height), String(target.width)]
            : []),
          source,
          '--out',
          output,
        ],
        signal,
      )
      const bytes = new Uint8Array(await readFile(output))
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
        throw new Error('sips did not write a JPEG')
      return bytes
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

/** The system encoder, or undefined off macOS. */
export const sipsTranscoder: ImageTranscoder | undefined =
  process.platform === 'darwin' ? new SipsTranscoder() : undefined
