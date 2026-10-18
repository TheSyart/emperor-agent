import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { rasterMatches } from './reference-images'
import {
  PublicHttpError,
  isPublicHttpRedirectResponse,
} from '../network/public-http'
import type { WebFetchClient } from '../network/web-fetch-client'
import type { ReferenceDescriptor } from './reference-types'

/** Presentation metadata only; remote URLs and raw source never cross this boundary. */
export interface ReferencePreview {
  state: 'ready' | 'unavailable' | 'error'
  title?: string
  description?: string
  status?: string
  iconDataUrl?: string
  thumbnailDataUrl?: string
  updatedAt: number
  reason?: string
}

export interface ReferencePreviewInput {
  sessionId: string
  referenceId: string
}

export interface GitHubPreviewTarget {
  kind: 'pull_request' | 'issue' | 'run'
  repo: string
  number: number
}

export type GitHubPreviewReader = (
  target: GitHubPreviewTarget,
  signal: AbortSignal,
) => Promise<ReferencePreview>

interface PreviewOptions {
  authorize(input: ReferencePreviewInput): ReferenceDescriptor
  webFetchClient?: WebFetchClient | null
  githubPreview?: GitHubPreviewReader
}

interface CachedPreview {
  binding: string
  value: ReferencePreview
}

const HTML_LIMIT = 1024 * 1024
const ICON_LIMIT = 256 * 1024
const THUMBNAIL_LIMIT = 512 * 1024
const DEADLINE_MS = 8_000
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_ENTRIES = 200
const MAX_ACTIVE = 4

export class ReferencePreviewService {
  private active = 0
  // Each session owns its own bounded LRU; unrelated chats cannot evict it.
  private readonly cache = new Map<string, Map<string, CachedPreview>>()

  constructor(private readonly options: PreviewOptions) {}

  async preview(
    input: ReferencePreviewInput,
    signal?: AbortSignal,
  ): Promise<ReferencePreview> {
    if (signal?.aborted) return failure('error', 'cancelled')
    let descriptor: ReferenceDescriptor
    try {
      descriptor = this.options.authorize(input)
    } catch {
      return failure('unavailable', 'reference_unavailable')
    }
    if (descriptor.kind !== 'web') {
      return {
        state: descriptor.available ? 'ready' : 'unavailable',
        title: descriptor.label,
        status: descriptor.available
          ? descriptor.directory
            ? 'directory'
            : 'file'
          : 'missing',
        updatedAt: Date.now(),
      }
    }
    const target = githubTarget(descriptor.tooltip)
    const key = input.referenceId
    const sessionCache = this.cache.get(input.sessionId)
    const binding = JSON.stringify(descriptor)
    const cached = target ? undefined : sessionCache?.get(key)
    if (
      cached &&
      cached.binding === binding &&
      Date.now() - cached.value.updatedAt >= 0 &&
      Date.now() - cached.value.updatedAt < CACHE_TTL_MS
    ) {
      sessionCache!.delete(key)
      sessionCache!.set(key, cached)
      return { ...cached.value }
    }
    sessionCache?.delete(key)
    if (sessionCache?.size === 0) this.cache.delete(input.sessionId)
    if (this.active >= MAX_ACTIVE) return failure('unavailable', 'busy')
    if (!target && !this.options.webFetchClient)
      return failure('unavailable', 'network_unavailable')
    if (target && !this.options.githubPreview)
      return failure('unavailable', 'github_unavailable')

    const controller = new AbortController()
    const cancel = () => controller.abort('cancelled')
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => controller.abort('timeout'), DEADLINE_MS)
    // No queue: the whole request, including all assets, shares one deadline.
    // Keep the slot until underlying work settles, even if a faulty injected
    // client ignores abort; timing out must never allow unbounded background IO.
    this.active += 1
    const work = (async () => {
      if (controller.signal.aborted) throw new PublicHttpError('cancelled')
      const result = target
        ? await this.options.githubPreview!(target, controller.signal)
        : await this.readWeb(descriptor.tooltip, controller.signal)
      if (controller.signal.aborted) throw new PublicHttpError('cancelled')
      try {
        if (JSON.stringify(this.options.authorize(input)) !== binding)
          return failure('unavailable', 'reference_unavailable')
      } catch {
        return failure('unavailable', 'reference_unavailable')
      }
      if (!target && result.state === 'ready') {
        const cache =
          this.cache.get(input.sessionId) ?? new Map<string, CachedPreview>()
        this.cache.set(input.sessionId, cache)
        cache.set(key, { binding, value: { ...result } })
        while (cache.size > CACHE_ENTRIES)
          cache.delete(cache.keys().next().value!)
      }
      return result
    })().finally(() => {
      this.active -= 1
    })
    try {
      return await abortable(work, controller.signal)
    } catch (error) {
      if (controller.signal.aborted)
        return failure(
          'error',
          controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled',
        )
      if (error instanceof PublicHttpError)
        return failure(
          error.code === 'network_failed' || error.code === 'timeout'
            ? 'error'
            : 'unavailable',
          error.code,
        )
      return failure('error', 'preview_failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }

  private async readWeb(
    url: string,
    signal: AbortSignal,
  ): Promise<ReferencePreview> {
    const response = await this.options.webFetchClient!.get({
      url: withoutFragment(url),
      protocols: ['https:'],
      maxBytes: HTML_LIMIT,
      signal,
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    if (signal.aborted) throw new PublicHttpError('cancelled')
    if (isPublicHttpRedirectResponse(response))
      return failure('unavailable', 'blocked_url')
    if (response.status < 200 || response.status >= 300)
      return failure(
        'unavailable',
        response.status === 404
          ? 'not_found'
          : [401, 403].includes(response.status)
            ? 'access_denied'
            : 'http_error',
      )
    if (response.body.byteLength > HTML_LIMIT)
      return failure('unavailable', 'response_too_large')
    const mime = contentType(response.headers['content-type'])
    if (mime !== 'text/html' && mime !== 'application/xhtml+xml')
      return failure('unavailable', 'unsupported_content')
    const metadata = htmlMetadata(Buffer.from(response.body).toString('utf8'))
    const value: ReferencePreview = {
      state: 'ready',
      updatedAt: Date.now(),
      ...(metadata.title
        ? { title: metadata.title }
        : { title: new URL(response.url).hostname }),
      ...(metadata.description ? { description: metadata.description } : {}),
    }
    // Sequential asset reads also keep total HTTP concurrency at four.
    if (metadata.icon) {
      const icon = await this.readAsset(
        metadata.icon,
        response.url,
        ICON_LIMIT,
        signal,
      )
      if (icon) value.iconDataUrl = icon
    }
    if (metadata.image) {
      const thumbnail = await this.readAsset(
        metadata.image,
        response.url,
        THUMBNAIL_LIMIT,
        signal,
      )
      if (thumbnail) value.thumbnailDataUrl = thumbnail
    }
    return value
  }

  private async readAsset(
    raw: string,
    base: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    try {
      if (signal.aborted) throw new PublicHttpError('cancelled')
      const url = new URL(raw, base)
      url.hash = ''
      // PublicHttpClient repeats protocol, credentials, DNS and redirect checks.
      const response = await this.options.webFetchClient!.get({
        url: url.toString(),
        protocols: ['https:'],
        maxBytes,
        signal,
        headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' },
      })
      if (signal.aborted) throw new PublicHttpError('cancelled')
      if (
        isPublicHttpRedirectResponse(response) ||
        response.status !== 200 ||
        response.body.byteLength > maxBytes
      )
        return undefined
      const mime = contentType(response.headers['content-type'])
      if (!rasterMatches(Buffer.from(response.body), mime)) return undefined
      return `data:${mime};base64,${Buffer.from(response.body).toString('base64')}`
    } catch {
      // Asset failures keep useful text metadata; abort is enforced by the
      // outer operation and prevents any subsequent asset from starting.
      return undefined
    }
  }
}

function failure(
  state: ReferencePreview['state'],
  reason: string,
): ReferencePreview {
  return { state, reason, updatedAt: Date.now() }
}

function withoutFragment(value: string): string {
  const url = new URL(value)
  url.hash = ''
  return url.toString()
}

function contentType(value: string | string[] | undefined): string {
  return (
    (Array.isArray(value) ? value[0] : value)
      ?.split(';')[0]
      ?.trim()
      .toLowerCase() ?? ''
  )
}

function githubTarget(value: string): GitHubPreviewTarget | undefined {
  const url = new URL(value)
  if (url.hostname.toLowerCase() !== 'github.com' || url.port) return undefined
  const match = url.pathname.match(
    /^\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)\/(pull|issues|actions\/runs)\/([1-9]\d*)(?:\/(?:files|commits|checks|job\/\d+))?\/?$/,
  )
  if (!match) return undefined
  const number = Number(match[4])
  const kind =
    match[3] === 'pull'
      ? 'pull_request'
      : match[3] === 'issues'
        ? 'issue'
        : 'run'
  if (
    !Number.isSafeInteger(number) ||
    (kind !== 'run' && number > 1_000_000_000)
  )
    return undefined
  return { kind, repo: `${match[1]}/${match[2]}`, number }
}

type Node = DefaultTreeAdapterMap['node']
function htmlMetadata(html: string): {
  title?: string
  description?: string
  icon?: string
  image?: string
} {
  const document = parse(html, { scriptingEnabled: false })
  let title: string | undefined
  let ogTitle: string | undefined
  let description: string | undefined
  let ogDescription: string | undefined
  let icon: string | undefined
  let image: string | undefined
  const stack: Node[] = [document]
  while (stack.length) {
    const node = stack.pop()!
    if (!('tagName' in node)) {
      if ('childNodes' in node) stack.push(...node.childNodes.slice().reverse())
      continue
    }
    // Template/noscript text is not active page metadata; never traverse them.
    if (['script', 'style', 'template', 'noscript'].includes(node.tagName))
      continue
    const attrs = Object.fromEntries(
      node.attrs.map((attr) => [attr.name, attr.value]),
    )
    if (node.tagName === 'title' && !title)
      title = cleanText(
        node.childNodes
          .filter((child) => child.nodeName === '#text')
          .map((child) => (child as DefaultTreeAdapterMap['textNode']).value)
          .join(''),
        300,
      )
    if (node.tagName === 'meta') {
      const key = (attrs.property ?? attrs.name ?? '').toLowerCase()
      if (key === 'og:title' && !ogTitle)
        ogTitle = cleanText(attrs.content, 300)
      if (key === 'description' && !description)
        description = cleanText(attrs.content, 600)
      if (key === 'og:description' && !ogDescription)
        ogDescription = cleanText(attrs.content, 600)
      if (key === 'og:image' && !image) image = cleanUrlValue(attrs.content)
    }
    if (
      node.tagName === 'link' &&
      !icon &&
      (attrs.rel ?? '').toLowerCase().split(/\s+/).includes('icon')
    )
      icon = cleanUrlValue(attrs.href)
    stack.push(...node.childNodes.slice().reverse())
  }
  return {
    title: ogTitle ?? title,
    description: ogDescription ?? description,
    icon,
    image,
  }
}

function cleanText(
  value: string | undefined,
  limit: number,
): string | undefined {
  const text = value
    ?.replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
  return text || undefined
}
function cleanUrlValue(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text && text.length <= 4096 ? text : undefined
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PublicHttpError('cancelled'))
    if (signal.aborted) abort()
    signal.addEventListener('abort', abort, { once: true })
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
