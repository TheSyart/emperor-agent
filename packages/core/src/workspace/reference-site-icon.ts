import {
  PublicHttpError,
  isPublicHttpRedirectResponse,
} from '../network/public-http'
import type { WebFetchClient } from '../network/web-fetch-client'
import type { ReferenceDescriptor } from './reference-types'
import type { ReferencePreviewInput } from './reference-preview'
import { rasterMatches } from './reference-images'

export interface ReferenceSiteIcon {
  state: 'ready' | 'unavailable'
  dataUrl?: string
  updatedAt: number
  reason?: string
}
interface Options {
  authorize(input: ReferencePreviewInput): ReferenceDescriptor
  webFetchClient?: WebFetchClient | null
}
const ICON_LIMIT = 256 * 1024
const MAX_CACHE = 200
const unavailable = (reason = 'icon_unavailable'): ReferenceSiteIcon => ({
  state: 'unavailable',
  reason,
  updatedAt: Date.now(),
})

/** Suffixes that name private, local or reserved hosts (RFC 6761, common LAN use). */
const PRIVATE_SUFFIX =
  /\.(?:local|localhost|localdomain|internal|intranet|lan|home|corp|private|test|example|invalid|arpa|onion)$/iu

/**
 * The hostname the icon service may hear about (BUG-01): a public, dotted
 * name on the default port; never an IP literal, a single-label or a
 * private/reserved suffix.
 */
export function publicHostname(url: URL): string | undefined {
  if (url.port) return undefined
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host.startsWith('[')) return undefined
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return undefined
  if (PRIVATE_SUFFIX.test(host)) return undefined
  return host
}

/** Public, origin-only branding. No article URL, cookies, auth or OG previews. */
export class ReferenceSiteIconService {
  private readonly cache = new Map<string, ReferenceSiteIcon>()
  private readonly pending = new Map<string, Promise<ReferenceSiteIcon>>()
  private readonly queue: Array<() => void> = []
  private active = 0
  constructor(private readonly options: Options) {}

  async icon(input: ReferencePreviewInput): Promise<ReferenceSiteIcon> {
    let origin: string
    try {
      const descriptor = this.options.authorize(input)
      if (descriptor.kind !== 'web') return unavailable()
      const url = new URL(descriptor.tooltip)
      if (
        url.username ||
        url.password ||
        !['http:', 'https:'].includes(url.protocol)
      )
        return unavailable('blocked_url')
      url.protocol = 'https:'
      origin = url.origin
    } catch {
      return unavailable('reference_unavailable')
    }
    if (!this.options.webFetchClient) return unavailable('network_unavailable')
    const cached = this.cache.get(origin)
    const ttl = cached?.state === 'ready' ? 24 * 60 * 60 * 1000 : 60_000
    let value: ReferenceSiteIcon
    if (
      cached &&
      Date.now() >= cached.updatedAt &&
      Date.now() - cached.updatedAt < ttl
    ) {
      this.cache.delete(origin)
      this.cache.set(origin, cached)
      value = cached
    } else {
      let work = this.pending.get(origin)
      if (!work) {
        if (this.pending.size >= 200) return unavailable('busy')
        work = this.schedule(() => this.fetch(origin))
          .then((result) => {
            this.cache.delete(origin)
            this.cache.set(origin, result)
            while (this.cache.size > MAX_CACHE)
              this.cache.delete(this.cache.keys().next().value!)
            return result
          })
          .finally(() => this.pending.delete(origin))
        this.pending.set(origin, work)
      }
      value = await work
    }
    try {
      const current = this.options.authorize(input)
      const url = new URL(current.tooltip)
      url.protocol = 'https:'
      if (current.kind !== 'web' || url.origin !== origin)
        return unavailable('reference_unavailable')
    } catch {
      return unavailable('reference_unavailable')
    }
    return { ...value }
  }
  private async schedule<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= 4)
      await new Promise<void>((resolve) => this.queue.push(resolve))
    else this.active++
    try {
      return await run()
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.active--
    }
  }
  /**
   * Only the icon service is asked, by hostname (BUG-01): the site itself
   * never learns that a link to it was shown, and a private or local host
   * name is never sent anywhere.
   */
  private async fetch(origin: string): Promise<ReferenceSiteIcon> {
    const host = publicHostname(new URL(origin))
    if (!host) return unavailable('private_host')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const image = await this.image(
        `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
        controller.signal,
      )
      return image
        ? { state: 'ready', dataUrl: image, updatedAt: Date.now() }
        : unavailable()
    } catch (error) {
      return unavailable(
        controller.signal.aborted
          ? 'timeout'
          : error instanceof PublicHttpError
            ? error.code
            : 'icon_unavailable',
      )
    } finally {
      clearTimeout(timer)
    }
  }
  private async image(
    url: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (signal.aborted) throw new PublicHttpError('cancelled')
    const response = await this.options.webFetchClient!.get({
      url,
      protocols: ['https:'],
      maxBytes: ICON_LIMIT,
      signal,
      headers: {
        accept:
          'image/png,image/x-icon,image/vnd.microsoft.icon,image/jpeg,image/webp,image/gif',
      },
    })
    if (
      isPublicHttpRedirectResponse(response) ||
      response.status !== 200 ||
      response.body.byteLength > ICON_LIMIT
    )
      return
    const bytes = Buffer.from(response.body)
    // Sniff bytes: many servers label ICO as application/octet-stream.
    for (const mime of [
      'image/png',
      'image/x-icon',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ])
      if (rasterMatches(bytes, mime))
        return `data:${mime};base64,${bytes.toString('base64')}`
    return
  }
}
