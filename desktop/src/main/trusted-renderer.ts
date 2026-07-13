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

export interface TrustedRendererPolicy {
  isTrustedUrl(value: string): boolean
  handleNavigation(event: NavigationEventLike, targetUrl: string): void
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
    void Promise.resolve()
      .then(() => opts.openExternal(candidate.toString()))
      .catch((error) => opts.onExternalOpenError?.(error, candidate.toString()))
  }

  return {
    isTrustedUrl,
    handleNavigation(event, targetUrl) {
      if (isTrustedUrl(targetUrl)) return
      event.preventDefault()
      openEligibleExternal(targetUrl)
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
