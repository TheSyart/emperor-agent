/**
 * Images through DeepSeek's Files API (KRN-07).
 *
 * An image is uploaded once (`POST {origin}/files`, purpose `user_data`,
 * expiring after a day) and referenced from /messages by file id. Uploads
 * use the OpenAI-compatible Files endpoint: it documents expiry and
 * creation-ordered listing, and its files are usable from the Anthropic
 * family too (https://api-docs.deepseek.com/guides/files_api).
 *
 * - The cache is keyed by endpoint + a SHA-256 of the API key (never the
 *   key), then by attachment; an id is reused while it has over an hour to
 *   live. It lives in memory; after a restart an image is uploaded again
 *   and the old file expires on its own.
 * - An image past the server's pixel budget or the byte target is
 *   re-encoded as JPEG at 85, then 75, then 60 (see transcode.ts).
 * - When the account is full, Emperor deletes its own oldest uploads
 *   (files named `emperor-…`, nothing else) and retries once.
 * - Any other failure sends the image inline (base64) and keeps that
 *   endpoint + key on inline images for ten minutes.
 */

import { createHash } from 'node:crypto'
import { imageDimensions } from '../../../attachments/image-dimensions'
import { logger } from '../../../util/log'
import type { ImageResolver } from '../../content'
import { httpErrorCode, LlmError } from '../../error'
import type { ImageAttachmentRef } from '../../types'
import {
  EMPEROR_FILE_PREFIX,
  FILE_EXPIRY_SECONDS,
  FILE_REFRESH_MARGIN_MS,
  FILES_BACKOFF_MS,
  FILES_LIST_LIMIT,
  FILES_LIST_MAX_PAGES,
  FILES_PATH,
  JPEG_QUALITIES,
  MAX_UPLOAD_BYTES,
  QUOTA_EVICTION_COUNT,
  REQUEST_IMAGE_MAX_PIXELS,
  UPLOAD_IMAGE_TARGET_BYTES,
  UPLOAD_VARIANT_VERSION,
} from './constants'
import { fitPixels, type ImageTranscoder } from './transcode'
import type { WireImageSource } from './types'

/** Endpoint + key namespace of the cache: a digest, so the key is never kept. */
export function fileScope(origin: string, apiKey: string): string {
  return createHash('sha256')
    .update(origin.trim().replace(/\/+$/, ''))
    .update('\0')
    .update(apiKey)
    .digest('hex')
}

/** A Files API failure, with the provider detail kept for quota detection. */
export class DeepSeekFilesError extends LlmError {
  readonly detail: string

  constructor(message: string, status: number, detail: string) {
    super(message, httpErrorCode(status, detail), { status })
    this.name = 'DeepSeekFilesError'
    this.detail = detail
  }
}

/**
 * Whether an upload failed because the account's file storage is full. The
 * guide gives the limits (10000 files, 25 GiB) but not the error, so this
 * reads the provider's wording.
 */
export function isFilesQuotaError(error: unknown): boolean {
  return (
    error instanceof DeepSeekFilesError &&
    error.failure.status !== undefined &&
    error.failure.status >= 400 &&
    error.failure.status < 500 &&
    error.failure.status !== 401 &&
    /quota|storage|stored files|file count|too many files|number of (?:stored )?files/i.test(
      `${error.detail} ${error.message}`,
    )
  )
}

interface RemoteFile {
  id: string
  filename: string
  createdAt: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function invalid(operation: string): LlmError {
  return new LlmError(
    `DeepSeek Files API returned an invalid ${operation} response.`,
    'INVALID_RESPONSE',
  )
}

/** The OpenAI-compatible Files endpoints of one origin and key. */
class FilesClient {
  constructor(
    private readonly origin: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async request(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.apiKey}` },
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      throw new LlmError(
        `DeepSeek Files API request to ${this.origin} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (response.ok) return parsed
    const error = record(record(parsed)?.['error'])
    const message =
      typeof error?.['message'] === 'string'
        ? error['message']
        : `DeepSeek Files API error (HTTP ${response.status})`
    const detail = [error?.['code'], error?.['type'], error?.['message']]
      .filter((field): field is string => typeof field === 'string')
      .join(' ')
    throw new DeepSeekFilesError(message, response.status, detail)
  }

  async upload(input: {
    data: Uint8Array
    mediaType: string
    filename: string
    signal?: AbortSignal
  }): Promise<{ id: string; expiresAt?: number }> {
    const form = new FormData()
    form.set('purpose', 'user_data')
    form.set('expires_after[anchor]', 'created_at')
    form.set('expires_after[seconds]', String(FILE_EXPIRY_SECONDS))
    form.set(
      'file',
      new Blob([Uint8Array.from(input.data)], { type: input.mediaType }),
      input.filename,
    )
    const file = record(
      await this.request(
        FILES_PATH,
        { method: 'POST', body: form },
        input.signal,
      ),
    )
    const id = file?.['id']
    if (typeof id !== 'string' || id.length === 0) throw invalid('upload')
    const expiresAt = file?.['expires_at']
    return {
      id,
      ...(typeof expiresAt === 'number' && Number.isFinite(expiresAt)
        ? { expiresAt: expiresAt * 1000 }
        : {}),
    }
  }

  async list(
    after: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ data: RemoteFile[]; hasMore: boolean; lastId?: string }> {
    const query = new URLSearchParams({
      purpose: 'user_data',
      order: 'asc',
      limit: String(FILES_LIST_LIMIT),
    })
    if (after !== undefined) query.set('after', after)
    const page = record(
      await this.request(
        `${FILES_PATH}?${query.toString()}`,
        { method: 'GET' },
        signal,
      ),
    )
    const data = page?.['data']
    if (!Array.isArray(data)) throw invalid('list')
    const files: RemoteFile[] = []
    for (const item of data) {
      const file = record(item)
      const id = file?.['id']
      if (typeof id !== 'string' || id.length === 0) continue
      files.push({
        id,
        filename:
          typeof file?.['filename'] === 'string' ? file['filename'] : '',
        createdAt:
          typeof file?.['created_at'] === 'number' ? file['created_at'] : 0,
      })
    }
    const lastId = page?.['last_id']
    return {
      data: files,
      hasMore: page?.['has_more'] === true,
      ...(typeof lastId === 'string' ? { lastId } : {}),
    }
  }

  async delete(id: string, signal: AbortSignal | undefined): Promise<void> {
    await this.request(
      `${FILES_PATH}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      signal,
    )
  }
}

interface CachedFile {
  fileId: string
  expiresAt: number
}

/** Uploaded file ids by scope and attachment, with each scope's back-off. */
class FileCache {
  private readonly scopes = new Map<string, Map<string, CachedFile>>()
  private readonly backoffUntil = new Map<string, number>()

  get(scope: string, key: string, now: number): CachedFile | undefined {
    const files = this.scopes.get(scope)
    const file = files?.get(key)
    if (file === undefined) return undefined
    if (file.expiresAt - now > FILE_REFRESH_MARGIN_MS) return file
    files?.delete(key)
    return undefined
  }

  put(scope: string, key: string, file: CachedFile): void {
    let files = this.scopes.get(scope)
    if (files === undefined) {
      files = new Map()
      this.scopes.set(scope, files)
    }
    files.delete(key)
    files.set(key, file)
  }

  forget(scope: string, fileIds: Iterable<string>): void {
    const files = this.scopes.get(scope)
    if (files === undefined) return
    const gone = new Set(fileIds)
    for (const [key, file] of files)
      if (gone.has(file.fileId)) files.delete(key)
  }

  backoff(scope: string, until: number): void {
    this.backoffUntil.set(scope, until)
  }

  inBackoff(scope: string, now: number): boolean {
    const until = this.backoffUntil.get(scope)
    if (until === undefined) return false
    if (now < until) return true
    this.backoffUntil.delete(scope)
    return false
  }
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export interface DeepSeekImageFilesOptions {
  fetch?: typeof fetch
  /** The JPEG encoder; null: upload images as they are. */
  transcoder?: ImageTranscoder | null
  now?: () => number
}

/** The request-time image path of the Messages adapter. */
export class DeepSeekImageFiles {
  private readonly cache = new FileCache()
  private readonly fetchImpl: typeof fetch
  private readonly transcoder: ImageTranscoder | null
  private readonly now: () => number

  constructor(options: DeepSeekImageFilesOptions = {}) {
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.transcoder = options.transcoder ?? null
    this.now = options.now ?? Date.now
  }

  /** The source one image travels as: a (cached) file id, or inline bytes. */
  async source(input: {
    origin: string
    apiKey: string
    ref: ImageAttachmentRef
    images: ImageResolver
    signal?: AbortSignal
  }): Promise<{ source: WireImageSource; fileId?: string }> {
    const scope = fileScope(input.origin, input.apiKey)
    const key = `${UPLOAD_VARIANT_VERSION}:${input.ref.attachmentId}`
    const cached = this.cache.get(scope, key, this.now())
    if (cached !== undefined)
      return {
        source: { type: 'file', file_id: cached.fileId },
        fileId: cached.fileId,
      }
    const resolved = await input.images(input.ref, input.signal)
    const variant = await this.variant(resolved, input.ref, input.signal)
    const inline = {
      source: {
        type: 'base64' as const,
        media_type: variant.mediaType,
        data: Buffer.from(variant.data).toString('base64'),
      },
    }
    if (
      this.cache.inBackoff(scope, this.now()) ||
      variant.data.byteLength > MAX_UPLOAD_BYTES
    )
      return inline
    const client = new FilesClient(
      input.origin.replace(/\/+$/, ''),
      input.apiKey,
      this.fetchImpl,
    )
    const filename = `${EMPEROR_FILE_PREFIX}${createHash('sha256')
      .update(key)
      .digest('hex')
      .slice(0, 24)}.${EXTENSIONS[variant.mediaType] ?? 'img'}`
    try {
      const file = await this.uploadWithCleanup(
        client,
        scope,
        { ...variant, filename },
        input.signal,
      )
      this.cache.put(scope, key, {
        fileId: file.id,
        expiresAt: file.expiresAt ?? this.now() + FILE_EXPIRY_SECONDS * 1000,
      })
      return { source: { type: 'file', file_id: file.id }, fileId: file.id }
    } catch (error: unknown) {
      if (input.signal?.aborted) throw error
      this.cache.backoff(scope, this.now() + FILES_BACKOFF_MS)
      logger.warn('DeepSeek Files API upload failed; sending images inline', {
        error: error instanceof Error ? error.message : String(error),
        status:
          error instanceof LlmError ? (error.failure.status ?? null) : null,
      })
      return inline
    }
  }

  /** Drop cached ids the endpoint no longer has (they are uploaded again next time). */
  invalidate(origin: string, apiKey: string, fileIds: readonly string[]): void {
    if (fileIds.length > 0)
      this.cache.forget(fileScope(origin, apiKey), fileIds)
  }

  private async uploadWithCleanup(
    client: FilesClient,
    scope: string,
    file: { data: Uint8Array; mediaType: string; filename: string },
    signal: AbortSignal | undefined,
  ): Promise<{ id: string; expiresAt?: number }> {
    const upload = () =>
      client.upload({ ...file, ...(signal === undefined ? {} : { signal }) })
    try {
      return await upload()
    } catch (error: unknown) {
      if (!isFilesQuotaError(error)) throw error
      const evicted = await this.evictOldest(client, scope, signal)
      if (evicted === 0) throw error
      return upload()
    }
  }

  /** Delete Emperor's oldest uploads (by creation time); returns how many went. */
  private async evictOldest(
    client: FilesClient,
    scope: string,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const victims: RemoteFile[] = []
    let after: string | undefined
    for (let page = 0; page < FILES_LIST_MAX_PAGES; page += 1) {
      const listed = await client.list(after, signal)
      for (const file of listed.data)
        if (file.filename.startsWith(EMPEROR_FILE_PREFIX)) victims.push(file)
      if (victims.length >= QUOTA_EVICTION_COUNT || !listed.hasMore) break
      after = listed.lastId ?? listed.data.at(-1)?.id
      if (after === undefined) break
    }
    victims.sort((a, b) => a.createdAt - b.createdAt)
    const deleted: string[] = []
    for (const file of victims.slice(0, QUOTA_EVICTION_COUNT)) {
      try {
        await client.delete(file.id, signal)
        deleted.push(file.id)
      } catch (error: unknown) {
        if (signal?.aborted) throw error
        logger.warn('DeepSeek Files API cleanup could not delete a file', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.cache.forget(scope, deleted)
    return deleted.length
  }

  /**
   * The bytes to upload: the original when it is within the pixel budget
   * and the byte target, else the first JPEG (85, 75, 60) under the target,
   * else the smallest of all.
   */
  private async variant(
    resolved: { data: Uint8Array; mediaType: string },
    ref: ImageAttachmentRef,
    signal: AbortSignal | undefined,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    const size =
      ref.width !== undefined && ref.height !== undefined
        ? { width: ref.width, height: ref.height }
        : imageDimensions(resolved.data)
    const overPixels =
      size !== null && size.width * size.height > REQUEST_IMAGE_MAX_PIXELS
    const overBytes = resolved.data.byteLength > UPLOAD_IMAGE_TARGET_BYTES
    if ((!overPixels && !overBytes) || this.transcoder === null) return resolved
    const target =
      size === null
        ? {}
        : fitPixels(size.width, size.height, REQUEST_IMAGE_MAX_PIXELS)
    let smallest: Uint8Array | undefined
    for (const quality of JPEG_QUALITIES) {
      let encoded: Uint8Array
      try {
        encoded = await this.transcoder.toJpeg(
          resolved,
          { quality, ...target },
          signal,
        )
      } catch (error: unknown) {
        if (signal?.aborted) throw error
        logger.warn('image re-encoding failed; uploading the original', {
          error: error instanceof Error ? error.message : String(error),
        })
        return resolved
      }
      if (encoded.byteLength <= UPLOAD_IMAGE_TARGET_BYTES)
        return { data: encoded, mediaType: 'image/jpeg' }
      if (smallest === undefined || encoded.byteLength < smallest.byteLength)
        smallest = encoded
    }
    return smallest !== undefined &&
      smallest.byteLength < resolved.data.byteLength
      ? { data: smallest, mediaType: 'image/jpeg' }
      : resolved
  }
}
