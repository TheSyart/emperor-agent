import { loadRemoteImage, openExternal, openLink } from '../api/backend'
import { remoteImageHost } from './useMarkdown'

export interface MarkdownReferenceRequest {
  href: string
  label: string
  sourceMessageId: string
}

/**
 * What a click on a link in rendered markdown does (UI-4). No link ever
 * navigates the window: every click is prevented and routed here.
 * - reference: chip links and paths (relative or absolute) go to Core's
 *   reference resolver (ChatView opens 文件 / the browser / Finder);
 * - web: an http(s) link that is not a chip opens like any user link;
 * - external: mailto: and tel: go to the system (shell.openExternal);
 * - anchor: `#…` and empty hrefs do nothing;
 * - refused: any other scheme is ignored, with a notice.
 */
export type MarkdownLinkAction =
  | { kind: 'reference'; href: string }
  | { kind: 'web'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'anchor' }
  | { kind: 'refused'; scheme: string }

export function markdownLinkAction(
  anchor: HTMLAnchorElement,
): MarkdownLinkAction {
  const href = (anchor.getAttribute('href') ?? '').trim()
  if (!href || href.startsWith('#')) return { kind: 'anchor' }
  if (anchor.classList.contains('md-link-chip'))
    return { kind: 'reference', href }
  if (/^https?:\/\//i.test(href)) return { kind: 'web', url: href }
  if (/^(?:mailto|tel):/i.test(href)) return { kind: 'external', url: href }
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(href)?.[1]
  if (scheme) return { kind: 'refused', scheme: scheme.toLowerCase() }
  return { kind: 'reference', href }
}

export interface MarkdownClickOptions {
  /** Tell the user why a link did nothing (app toast). */
  notify?: (message: string) => void
}

/**
 * The click handler of every rendered markdown container: remote image
 * placeholders load on request, and links follow `markdownLinkAction`.
 */
export function handleMarkdownClick(
  event: MouseEvent,
  sourceMessageId = 'markdown',
  options: MarkdownClickOptions = {},
): void {
  const target = event.target as HTMLElement | null
  if (activateRemoteImage(event, target, options)) return
  const anchor = target?.closest?.('a')
  if (!(anchor instanceof HTMLAnchorElement)) return
  event.preventDefault()
  event.stopPropagation()
  const action = markdownLinkAction(anchor)
  const failed = () => options.notify?.('无法打开这个链接')
  switch (action.kind) {
    case 'reference':
      window.dispatchEvent(
        new CustomEvent<MarkdownReferenceRequest>('emperor:resolve-reference', {
          detail: {
            href: action.href,
            label: anchor.textContent?.trim() || action.href,
            sourceMessageId,
          },
        }),
      )
      return
    case 'web':
      void openLink(action.url).catch(failed)
      return
    case 'external':
      void openExternal(action.url).catch(failed)
      return
    case 'refused':
      options.notify?.(`不支持打开 ${action.scheme} 链接`)
      return
    case 'anchor':
      return
  }
}

/** Enter / Space on a focused remote image placeholder loads it. */
export function handleMarkdownKeydown(
  event: KeyboardEvent,
  options: MarkdownClickOptions = {},
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  activateRemoteImage(event, event.target as HTMLElement | null, options)
}

/** @deprecated The old name; every markdown link is handled now. */
export const handleMarkdownChipClick = handleMarkdownClick

// ── remote images (UI-38) ───────────────────────────────────────────────

/**
 * Images the user asked for in this window session, by address: shown again
 * without a new request when the same reply re-renders (bounded).
 */
const loaded = new Map<string, string>()
const MAX_REMEMBERED = 64

/** Tests: forget the images loaded so far. */
export function forgetRemoteImages(): void {
  loaded.clear()
}

function activateRemoteImage(
  event: Event,
  target: HTMLElement | null,
  options: MarkdownClickOptions,
): boolean {
  const placeholder = target?.closest?.<HTMLElement>('[data-md-remote-image]')
  if (!placeholder) return false
  event.preventDefault()
  event.stopPropagation()
  void loadPlaceholder(placeholder, options)
  return true
}

async function loadPlaceholder(
  placeholder: HTMLElement,
  options: MarkdownClickOptions,
): Promise<void> {
  if (placeholder.dataset.mdRemoteState === 'loading') return
  const url = placeholder.dataset.mdRemoteImage ?? ''
  const host = remoteImageHost(url) ?? url
  const cached = loaded.get(url)
  if (cached) {
    showImage(placeholder, cached)
    return
  }
  placeholder.dataset.mdRemoteState = 'loading'
  placeholder.setAttribute('aria-busy', 'true')
  placeholder.textContent = `正在加载图片 · ${host}`
  let reason = '图片加载失败'
  try {
    const result = await loadRemoteImage(url)
    if (result.ok) {
      remember(url, result.dataUrl)
      if (placeholder.isConnected) showImage(placeholder, result.dataUrl)
      return
    }
    reason = result.error || reason
  } catch (error) {
    reason = error instanceof Error && error.message ? error.message : reason
  }
  placeholder.removeAttribute('aria-busy')
  placeholder.dataset.mdRemoteState = 'failed'
  placeholder.textContent = `${reason} · ${host}（点击重试）`
  options.notify?.(reason)
}

function remember(url: string, dataUrl: string): void {
  loaded.delete(url)
  loaded.set(url, dataUrl)
  while (loaded.size > MAX_REMEMBERED) {
    const oldest = loaded.keys().next().value
    if (oldest === undefined) break
    loaded.delete(oldest)
  }
}

function showImage(placeholder: HTMLElement, dataUrl: string): void {
  const image = document.createElement('img')
  image.className = 'md-image-preview md-remote-image-loaded'
  image.alt = placeholder.dataset.mdRemoteAlt || '图片'
  image.title = placeholder.dataset.mdRemoteImage ?? ''
  image.src = dataUrl
  // The same affordance as the other previews: opens the image viewer.
  image.tabIndex = 0
  image.setAttribute('role', 'button')
  image.setAttribute('aria-label', `放大预览 ${image.alt}`)
  placeholder.replaceWith(image)
}

/**
 * Placeholders of images already loaded in this session show the image
 * again (no request) — for containers that re-render their markdown.
 */
export function restoreRemoteImages(root: HTMLElement): HTMLImageElement[] {
  const shown: HTMLImageElement[] = []
  root
    .querySelectorAll<HTMLElement>('[data-md-remote-image]')
    .forEach((placeholder) => {
      const cached = loaded.get(placeholder.dataset.mdRemoteImage ?? '')
      if (!cached) return
      showImage(placeholder, cached)
    })
  root
    .querySelectorAll<HTMLImageElement>('img.md-remote-image-loaded')
    .forEach((image) => shown.push(image))
  return shown
}
