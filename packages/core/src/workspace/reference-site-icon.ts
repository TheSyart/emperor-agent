import type { DefaultTreeAdapterMap } from 'parse5'
import { htmlParser } from '../network/html-parser'
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
  private async fetch(origin: string): Promise<ReferenceSiteIcon> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      for (const path of ['/favicon.ico', '/apple-touch-icon.png']) {
        const image = await this.image(
          new URL(path, origin).toString(),
          controller.signal,
        )
        if (image)
          return { state: 'ready', dataUrl: image, updatedAt: Date.now() }
      }
      let home
      try {
        home = await this.options.webFetchClient!.get({
          url: origin + '/',
          protocols: ['https:'],
          maxBytes: ICON_LIMIT,
          signal: controller.signal,
          headers: { accept: 'text/html' },
        })
      } catch (error) {
        if (
          !(error instanceof PublicHttpError) ||
          error.code !== 'response_too_large'
        )
          throw error
      }
      if (
        home &&
        !isPublicHttpRedirectResponse(home) &&
        home.status === 200 &&
        /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(
          String(home.headers['content-type'] ?? ''),
        ) &&
        home.body.byteLength <= ICON_LIMIT
      ) {
        for (const href of await iconLinks(
          Buffer.from(home.body).toString('utf8'),
        )) {
          const url = new URL(href, home.url)
          if (url.protocol !== 'https:' || url.username || url.password)
            continue
          const image = await this.image(url.toString(), controller.signal)
          if (image)
            return { state: 'ready', dataUrl: image, updatedAt: Date.now() }
        }
      }
      // The fallback receives only the public hostname, never a path/query.
      const url = new URL(origin)
      if (!url.port) {
        const image = await this.image(
          `https://icons.duckduckgo.com/ip3/${encodeURIComponent(url.hostname)}.ico`,
          controller.signal,
        )
        if (image)
          return { state: 'ready', dataUrl: image, updatedAt: Date.now() }
      }
      return unavailable()
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
async function iconLinks(html: string): Promise<string[]> {
  const { parse } = await htmlParser()
  const stack: DefaultTreeAdapterMap['node'][] = [
    parse(html, { scriptingEnabled: false }),
  ]
  const icons: string[] = []
  while (stack.length) {
    const node = stack.pop()!
    if (
      'tagName' in node &&
      ['script', 'style', 'template', 'noscript'].includes(node.tagName)
    )
      continue
    if ('tagName' in node && node.tagName === 'link') {
      const attrs = Object.fromEntries(node.attrs.map((a) => [a.name, a.value]))
      if (
        /(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(attrs.rel ?? '') &&
        attrs.href &&
        attrs.href.length <= 4096 &&
        !/\.svg(?:[?#]|$)/i.test(attrs.href)
      )
        icons.push(attrs.href)
    }
    if ('childNodes' in node) stack.push(...node.childNodes.slice().reverse())
  }
  return [...new Set(icons)].slice(0, 3)
}
