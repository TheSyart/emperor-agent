import {
  PublicHttpClient,
  PublicHttpError,
  type PublicHttpTransport,
  type PublicHttpTransportRequest,
  type PublicHttpTransportResponse,
  type PublicHttpResolvedAddress,
  type WebFetchClient,
} from '@emperor/core/host-capabilities'

const DEFAULT_TIMEOUT_MS = 30_000

export interface ElectronRequestOptions {
  url: string
  method: 'GET'
  headers: Record<string, string>
  redirect: 'manual'
  credentials: 'omit'
  useSessionCookies: false
  bypassCustomProtocolHandlers: true
}

export interface ElectronResponseLike extends AsyncIterable<Uint8Array> {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  destroy(): void
}

export interface ElectronRequestLike {
  on(
    event: 'response',
    listener: (response: ElectronResponseLike) => void,
  ): this
  on(
    event: 'redirect',
    listener: (
      statusCode: number,
      method: string,
      redirectUrl: string,
      responseHeaders: Record<string, string[]>,
    ) => void,
  ): this
  on(event: 'error', listener: (error: Error) => void): this
  end(): void
  abort(): void
}

export type ElectronRequestFactory = (
  options: ElectronRequestOptions,
) => ElectronRequestLike

export interface DesktopWebFetchDependencies {
  resolveProxy(url: string): Promise<string>
  request: ElectronRequestFactory
  resolve?: (hostname: string) => Promise<PublicHttpResolvedAddress[]>
}

export function hasTrustedProxyRoute(route: string): boolean {
  return String(route ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .some((entry) => /^(?:PROXY|HTTPS?|SOCKS5?)\s+\S+/i.test(entry))
}

export class ElectronPublicHttpTransport implements PublicHttpTransport {
  constructor(
    private readonly requestFactory: ElectronRequestFactory,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async request(
    input: PublicHttpTransportRequest,
  ): Promise<PublicHttpTransportResponse> {
    if (input.signal.aborted)
      throw new PublicHttpError('cancelled', input.signal.reason)

    return await new Promise((resolve, reject) => {
      const request = this.requestFactory({
        url: input.url.toString(),
        method: 'GET',
        headers: {
          accept: '*/*',
          'user-agent': 'Emperor-Agent/1',
          ...input.headers,
        },
        redirect: 'manual',
        credentials: 'omit',
        useSessionCookies: false,
        bypassCustomProtocolHandlers: true,
      })
      let settled = false
      let closed = false
      let activeResponse: ElectronResponseLike | null = null
      const cleanup = (): void => {
        clearTimeout(timer)
        input.signal.removeEventListener('abort', onAbort)
      }
      const close = (): void => {
        if (closed) return
        closed = true
        cleanup()
        activeResponse?.destroy()
        request.abort()
      }
      const fail = (error: Error): void => {
        if (closed) return
        if (!settled) {
          settled = true
          reject(error)
        }
        close()
      }
      const onAbort = (): void => {
        fail(new PublicHttpError('cancelled', input.signal.reason))
      }
      const timer = setTimeout(() => {
        fail(new PublicHttpError('timeout'))
      }, this.timeoutMs)
      timer.unref?.()
      input.signal.addEventListener('abort', onAbort, { once: true })
      request.on('error', (error) => fail(error))
      request.on('redirect', (statusCode, _method, redirectUrl, headers) => {
        if (settled || closed) return
        settled = true
        closed = true
        cleanup()
        request.abort()
        const responseHeaders = {
          ...headers,
          ...(headers.location ? {} : { location: [redirectUrl] }),
        }
        resolve({
          statusCode,
          headers: responseHeaders,
          body: emptyBody(),
          close: () => request.abort(),
        })
      })
      request.on('response', (response) => {
        if (settled || closed) {
          response.destroy()
          return
        }
        settled = true
        activeResponse = response
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: response,
          close,
        })
      })
      request.end()
    })
  }
}

export function createDesktopWebFetchClient(
  deps: DesktopWebFetchDependencies,
): WebFetchClient {
  return new PublicHttpClient({
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    syntheticProxyRoute: {
      transport: new ElectronPublicHttpTransport(deps.request),
      canRoute: async (url) =>
        hasTrustedProxyRoute(await deps.resolveProxy(url.toString())),
    },
  })
}

async function* emptyBody(): AsyncIterable<Uint8Array> {
  // Manual redirect responses intentionally have no body.
}
