export interface IpcFrameLike {
  readonly url: string
  readonly top: unknown
}

export interface IpcInvokeEventLike {
  readonly sender: unknown
  readonly senderFrame: IpcFrameLike | null
}

export interface NavigationEventLike {
  preventDefault(): void
}

/** `will-frame-navigate` details (Electron passes them as the event). */
export interface FrameNavigationEventLike extends NavigationEventLike {
  readonly url: string
  readonly isMainFrame: boolean
}

export interface TrustedRendererPolicy {
  isTrustedUrl(value: string): boolean
  /**
   * `will-navigate` / `will-redirect`. With `currentUrl` (will-navigate),
   * the window stays on its document: only a reload of it (same URL, the
   * hash aside) passes, so no link in a reply can reload the app (UI-4).
   * An untrusted target is stopped and, when it is http(s), opened as a
   * user link.
   */
  handleNavigation(
    event: NavigationEventLike,
    targetUrl: string,
    currentUrl?: string,
  ): void
  /** `will-frame-navigate`: subframes never navigate (frame-src 'none'). */
  handleFrameNavigation(event: FrameNavigationEventLike): void
  handleWindowOpen(details: { url: string }): { action: 'deny' }
  authorizeIpc(event: unknown): void
}

export class UntrustedIpcCallerError extends Error {
  constructor() {
    super('IPC caller is not trusted')
    this.name = 'UntrustedIpcCallerError'
  }

  toSafe(): { code: string; message: string } {
    return {
      code: 'forbidden_ipc_caller',
      message: 'IPC caller is not trusted',
    }
  }
}

export function createTrustedRendererPolicy(opts: {
  productionUrl: string
  developmentUrl?: string | null
  mainWebContents: () => unknown | null
  openExternal: (url: string) => Promise<unknown>
  /**
   * Route a user's link through the browser settings instead of always
   * handing it to the system browser (main window only).
   */
  openLink?: (url: string) => Promise<unknown>
  onExternalOpenError?: (error: unknown, url: string) => void
}): TrustedRendererPolicy {
  const production = parseUrl(opts.productionUrl)
  const development = parseDevelopmentOrigin(opts.developmentUrl)

  const isTrustedUrl = (value: string): boolean => {
    const candidate = parseUrl(value)
    if (!candidate || hasCredentials(candidate)) return false
    if (
      production &&
      candidate.protocol === production.protocol &&
      candidate.host === production.host
    )
      return true
    return Boolean(development && candidate.origin === development)
  }

  const openEligibleExternal = (value: string): void => {
    const candidate = parseUrl(value)
    if (
      !candidate ||
      hasCredentials(candidate) ||
      !['http:', 'https:'].includes(candidate.protocol)
    )
      return
    const open = opts.openLink ?? opts.openExternal
    void Promise.resolve()
      .then(() => open(candidate.toString()))
      .catch((error) => opts.onExternalOpenError?.(error, candidate.toString()))
  }

  return {
    isTrustedUrl,
    handleNavigation(event, targetUrl, currentUrl) {
      if (isTrustedUrl(targetUrl)) {
        if (currentUrl !== undefined && !sameDocument(targetUrl, currentUrl))
          event.preventDefault()
        return
      }
      event.preventDefault()
      openEligibleExternal(targetUrl)
    },
    handleFrameNavigation(event) {
      if (!event.isMainFrame) event.preventDefault()
    },
    handleWindowOpen(details) {
      if (!isTrustedUrl(details.url)) openEligibleExternal(details.url)
      return { action: 'deny' }
    },
    authorizeIpc(event) {
      if (!isIpcInvokeEvent(event)) throw new UntrustedIpcCallerError()
      const frame = event.senderFrame
      const main = opts.mainWebContents()
      if (
        !main ||
        event.sender !== main ||
        !frame ||
        frame.top !== frame ||
        !isTrustedUrl(frame.url)
      )
        throw new UntrustedIpcCallerError()
    },
  }
}

function parseUrl(value: string | null | undefined): URL | null {
  try {
    return new URL(String(value ?? ''))
  } catch {
    return null
  }
}

/** The same document, the fragment aside (a reload). */
function sameDocument(target: string, current: string): boolean {
  const a = parseUrl(target)
  const b = parseUrl(current)
  if (!a || !b) return false
  a.hash = ''
  b.hash = ''
  return a.href === b.href
}

function parseDevelopmentOrigin(
  value: string | null | undefined,
): string | null {
  const url = parseUrl(value)
  if (
    !url ||
    hasCredentials(url) ||
    !['http:', 'https:'].includes(url.protocol)
  )
    return null
  return url.origin
}

function hasCredentials(url: URL): boolean {
  return Boolean(url.username || url.password)
}

function isIpcInvokeEvent(value: unknown): value is IpcInvokeEventLike {
  return Boolean(value && typeof value === 'object' && 'sender' in value)
}
