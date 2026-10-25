import { core } from '../../../api/http'
import type { DisplayResource } from './resourceModel'
import { uiPreferences } from '../../../composables/useUiPreferences'

export function safeSiteIcon(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 350_000 &&
    /^data:image\/(?:png|jpeg|gif|webp|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      value,
    )
    ? value
    : null
}
type Identity = Pick<DisplayResource, 'href' | 'sourceMessageId' | 'label'>
type RequestIcon = (
  sessionId: string,
  resource: Identity,
) => Promise<string | null>
const publicIcons = new Map<string, string>()
const listeners = new Set<() => void>()
export function cachedSiteIcon(href: string): string | undefined {
  try {
    return publicIcons.get(new URL(href).origin)
  } catch {
    return undefined
  }
}
export function onSiteIconsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Share requests across message, card and sidebar; bound both IO and memory. */
export function createSiteIconLoader(request: RequestIcon) {
  const cache = new Map<string, { value: string | null; at: number }>()
  const pending = new Map<string, Promise<string | null>>()
  const queue: Array<() => void> = []
  let active = 0
  async function run(sessionId: string, resource: Identity) {
    if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve))
    else active++
    try {
      return safeSiteIcon(await request(sessionId, resource))
    } catch {
      return null
    } finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
  return async (
    sessionId: string,
    resource: Identity,
  ): Promise<string | null> => {
    if (!sessionId) return null
    let origin: string
    try {
      const url = new URL(resource.href)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return null
      origin = url.origin
    } catch {
      return null
    }
    const key = `${sessionId}\0${origin}`
    const cached = cache.get(key)
    if (cached && Date.now() - cached.at < (cached.value ? 600_000 : 60_000)) {
      cache.delete(key)
      cache.set(key, cached)
      return cached.value
    }
    const existing = pending.get(key)
    if (existing) return existing
    if (pending.size >= 200) return null
    const work = run(sessionId, resource)
      .then((value) => {
        cache.delete(key)
        cache.set(key, { value, at: Date.now() })
        while (cache.size > 600) cache.delete(cache.keys().next().value!)
        return value
      })
      .finally(() => pending.delete(key))
    pending.set(key, work)
    return work
  }
}
const loadSiteIconFromCore = createSiteIconLoader(
  async (sessionId, resource) => {
    const reference = await core('references.resolve', {
      sessionId,
      sourceMessageId: resource.sourceMessageId,
      href: resource.href,
      label: resource.label,
    })
    const result = await core('references.siteIcon', {
      sessionId,
      referenceId: reference.id,
    })
    const image = result.state === 'ready' ? safeSiteIcon(result.dataUrl) : null
    if (image) {
      const origin = new URL(resource.href).origin
      publicIcons.delete(origin)
      publicIcons.set(origin, image)
      while (publicIcons.size > 200)
        publicIcons.delete(publicIcons.keys().next().value!)
      for (const listener of listeners) listener()
    }
    return image
  },
)

/**
 * Real site icons contact the linked site (and its favicon host), which a
 * crafted link could use as a read receipt, so they stay off unless the user
 * turns on 设置 › 常规 › 显示网站图标. Off means no request at all.
 */
export function loadSiteIcon(
  sessionId: string,
  resource: Parameters<typeof loadSiteIconFromCore>[1],
): Promise<string | null> {
  if (!uiPreferences().siteIconService) return Promise.resolve(null)
  return loadSiteIconFromCore(sessionId, resource)
}

/** Do not fetch offscreen history or every link in a long streamed response. */
export function whenVisible(element: Element, run: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    run()
    return () => {}
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      observer.disconnect()
      run()
    },
    { rootMargin: '80px' },
  )
  observer.observe(element)
  return () => observer.disconnect()
}

export function hydrateMarkdownSiteIcons(
  element: HTMLElement,
  sessionId: string,
  sourceMessageId: string,
): () => void {
  let disposed = false
  const stops: Array<() => void> = []
  for (const anchor of element.querySelectorAll<HTMLAnchorElement>(
    'a.md-link-chip[data-resource-kind="web"]',
  )) {
    if (anchor.querySelector('img.site-icon')) continue
    stops.push(
      whenVisible(anchor, () => {
        void loadSiteIcon(sessionId, {
          href: anchor.getAttribute('href') ?? '',
          sourceMessageId,
          label: anchor.textContent ?? '',
        }).then((value) => {
          if (disposed || !anchor.isConnected || !value) return
          const image = document.createElement('img')
          image.className = 'site-icon'
          image.alt = ''
          image.width = 14
          image.height = 14
          image.decoding = 'async'
          image.src = value
          image.onerror = () => {
            image.remove()
            delete anchor.dataset.siteIcon
          }
          anchor.prepend(image)
          anchor.dataset.siteIcon = 'ready'
        })
      }),
    )
  }
  return () => {
    disposed = true
    for (const stop of stops) stop()
  }
}
