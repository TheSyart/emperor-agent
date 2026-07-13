import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

export type PublicHttpErrorCode =
  | 'blocked_url'
  | 'blocked_address'
  | 'dns_failed'
  | 'network_failed'
  | 'redirect_limit'
  | 'response_too_large'
  | 'invalid_response'
  | 'cancelled'
  | 'timeout'

export class PublicHttpError extends Error {
  readonly code: PublicHttpErrorCode

  constructor(code: PublicHttpErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'PublicHttpError'
    this.code = code
  }
}

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface PublicHttpRequest {
  url: string
  protocols: readonly ('http:' | 'https:')[]
  maxBytes: number
  signal: AbortSignal
  headers?: Record<string, string>
}

export interface PublicHttpTransportRequest {
  url: URL
  address: string
  family: 4 | 6
  signal: AbortSignal
  headers: Record<string, string>
}

export interface PublicHttpTransportResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  close(): void
}

export interface PublicHttpOpenedResponse extends PublicHttpTransportResponse {
  url: URL
}

export interface PublicHttpResponse {
  url: string
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Uint8Array
}

export interface PublicHttpTransport {
  request(
    request: PublicHttpTransportRequest,
  ): Promise<PublicHttpTransportResponse>
}

export interface PublicHttpClientOptions {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  transport?: PublicHttpTransport
  maxRedirects?: number
  timeoutMs?: number
}

const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 30_000
const ABSOLUTE_MAX_BYTES = 20_000_000_000

export class PublicHttpClient {
  private readonly resolve: (hostname: string) => Promise<ResolvedAddress[]>
  private readonly transport: PublicHttpTransport
  private readonly maxRedirects: number

  constructor(opts: PublicHttpClientOptions = {}) {
    this.resolve = opts.resolve ?? resolvePublicAddresses
    this.transport =
      opts.transport ??
      new NodePublicHttpTransport(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.maxRedirects = normalizeRedirectLimit(
      opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    )
  }

  async open(request: PublicHttpRequest): Promise<PublicHttpOpenedResponse> {
    const maxBytes = normalizeMaxBytes(request.maxBytes)
    throwIfCancelled(request.signal)
    let url = parsePublicUrl(request.url, request.protocols)

    for (let redirects = 0; ; redirects += 1) {
      throwIfCancelled(request.signal)
      const hostname = normalizedHostname(url)
      let addresses: ResolvedAddress[]
      try {
        addresses = await this.resolve(hostname)
      } catch (cause) {
        if (request.signal.aborted)
          throw new PublicHttpError('cancelled', cause)
        throw new PublicHttpError('dns_failed', cause)
      }
      if (!addresses.length || addresses.some((entry) => !isPublicIp(entry)))
        throw new PublicHttpError('blocked_address')

      const selected = addresses[0]!
      let response: PublicHttpTransportResponse
      try {
        response = await this.transport.request({
          url,
          address: selected.address,
          family: selected.family,
          signal: request.signal,
          headers: request.headers ?? {},
        })
      } catch (cause) {
        if (request.signal.aborted)
          throw new PublicHttpError('cancelled', cause)
        if (cause instanceof PublicHttpError) throw cause
        throw new PublicHttpError('network_failed', cause)
      }

      const location = headerValue(response.headers.location)
      if (isRedirect(response.statusCode)) {
        response.close()
        if (redirects >= this.maxRedirects)
          throw new PublicHttpError('redirect_limit')
        if (!location) throw new PublicHttpError('invalid_response')
        let redirected: string
        try {
          redirected = new URL(location, url).toString()
        } catch (cause) {
          throw new PublicHttpError('blocked_url', cause)
        }
        url = parsePublicUrl(redirected, request.protocols)
        continue
      }

      let declaredLength: number | null
      try {
        declaredLength = parseContentLength(
          headerValue(response.headers['content-length']),
        )
      } catch (error) {
        response.close()
        throw error
      }
      if (declaredLength !== null && declaredLength > maxBytes) {
        response.close()
        throw new PublicHttpError('response_too_large')
      }
      return { ...response, url }
    }
  }

  async get(request: PublicHttpRequest): Promise<PublicHttpResponse> {
    const maxBytes = normalizeMaxBytes(request.maxBytes)
    const response = await this.open(request)
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      for await (const chunk of response.body) {
        throwIfCancelled(request.signal)
        const buffer = Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > maxBytes) throw new PublicHttpError('response_too_large')
        chunks.push(buffer)
      }
      return {
        url: response.url.toString(),
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks, bytes),
      }
    } finally {
      response.close()
    }
  }
}

export class NodePublicHttpTransport implements PublicHttpTransport {
  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async request(
    input: PublicHttpTransportRequest,
  ): Promise<PublicHttpTransportResponse> {
    return await new Promise((resolve, reject) => {
      const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
        callback(null, input.address, input.family)
      }
      const options = {
        method: 'GET',
        headers: {
          accept: '*/*',
          'user-agent': 'Emperor-Agent/1',
          ...input.headers,
        },
        lookup: pinnedLookup,
        family: input.family,
        signal: input.signal,
        ...(input.url.protocol === 'https:'
          ? { servername: normalizedHostname(input.url) }
          : {}),
      }
      const onResponse = (response: import('node:http').IncomingMessage) => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          close: () => response.destroy(),
        })
      }
      const request =
        input.url.protocol === 'https:'
          ? httpsRequest(input.url, options, onResponse)
          : httpRequest(input.url, options, onResponse)
      request.setTimeout(this.timeoutMs, () =>
        request.destroy(new PublicHttpError('timeout')),
      )
      request.once('error', reject)
      request.end()
    })
  }
}

export async function resolvePublicAddresses(
  hostname: string,
): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses
    .filter(
      (entry): entry is { address: string; family: 4 | 6 } =>
        entry.family === 4 || entry.family === 6,
    )
    .map((entry) => ({ address: entry.address, family: entry.family }))
}

const blockedAddresses = createBlockedAddressLists()

export function isPublicIp(entry: ResolvedAddress): boolean {
  if (isIP(entry.address) !== entry.family) return false
  return !blockedAddresses[entry.family].check(
    entry.address,
    entry.family === 4 ? 'ipv4' : 'ipv6',
  )
}

function createBlockedAddressLists(): Record<4 | 6, BlockList> {
  const ipv4 = new BlockList()
  const ipv6 = new BlockList()
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    ipv4.addSubnet(network, prefix, 'ipv4')
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const)
    ipv6.addSubnet(network, prefix, 'ipv6')
  return { 4: ipv4, 6: ipv6 }
}

function parsePublicUrl(
  value: string,
  protocols: readonly ('http:' | 'https:')[],
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new PublicHttpError('blocked_url', cause)
  }
  const hostname = normalizedHostname(url).toLowerCase()
  if (
    !protocols.includes(url.protocol as 'http:' | 'https:') ||
    url.username ||
    url.password ||
    url.hash ||
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.local')
  )
    throw new PublicHttpError('blocked_url')
  return url
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function normalizeRedirectLimit(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 20)
    throw new RangeError('maxRedirects must be an integer between 0 and 20')
  return value
}

function normalizeMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ABSOLUTE_MAX_BYTES)
    throw new RangeError('maxBytes is outside the supported range')
  return value
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new PublicHttpError('cancelled', signal.reason)
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode)
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null
  if (!/^\d+$/.test(value)) throw new PublicHttpError('invalid_response')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed))
    throw new PublicHttpError('invalid_response')
  return parsed
}
