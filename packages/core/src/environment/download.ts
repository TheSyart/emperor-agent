import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { dirname } from 'node:path'
import { EnvironmentError } from './errors'

const MAX_REDIRECTS = 3
const MAX_DOWNLOAD_BYTES = 20_000_000_000
const REQUEST_TIMEOUT_MS = 60_000

export interface AssetDownloadRequest {
  url: string
  destination: string
  maxBytes: number
  signal: AbortSignal
}

export interface AssetDownloader {
  download(request: AssetDownloadRequest): Promise<void>
}

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface HttpsAssetTransportRequest {
  url: URL
  address: string
  family: 4 | 6
  signal: AbortSignal
}

export interface HttpsAssetTransportResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  close(): void
}

export interface HttpsAssetTransport {
  request(
    request: HttpsAssetTransportRequest,
  ): Promise<HttpsAssetTransportResponse>
}

export interface NodeHttpsAssetDownloaderOptions {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  transport?: HttpsAssetTransport
}

export class NodeHttpsAssetDownloader implements AssetDownloader {
  private readonly resolve: (hostname: string) => Promise<ResolvedAddress[]>
  private readonly transport: HttpsAssetTransport

  constructor(opts: NodeHttpsAssetDownloaderOptions = {}) {
    this.resolve = opts.resolve ?? resolvePublicAddresses
    this.transport = opts.transport ?? new NodeHttpsAssetTransport()
  }

  async download(request: AssetDownloadRequest): Promise<void> {
    const maxBytes = validateMaxBytes(request.maxBytes)
    if (request.signal.aborted) throw new EnvironmentError('cancelled')
    let url = parsePublicHttpsUrl(request.url)
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const addresses = await this.resolve(url.hostname).catch((cause) => {
        throw new EnvironmentError('network_unavailable', { cause })
      })
      if (!addresses.length || addresses.some((entry) => !isPublicIp(entry)))
        throw new EnvironmentError('redirect_blocked')
      const selected = addresses[0]!
      let response: HttpsAssetTransportResponse
      try {
        response = await this.transport.request({
          url,
          address: selected.address,
          family: selected.family,
          signal: request.signal,
        })
      } catch (cause) {
        if (request.signal.aborted) throw new EnvironmentError('cancelled')
        throw cause instanceof EnvironmentError
          ? cause
          : new EnvironmentError('download_failed', { cause })
      }
      const location = headerValue(response.headers.location)
      if (isRedirect(response.statusCode)) {
        response.close()
        if (!location || redirects === MAX_REDIRECTS)
          throw new EnvironmentError('redirect_blocked')
        url = parsePublicHttpsUrl(new URL(location, url).toString())
        continue
      }
      if (response.statusCode !== 200) {
        response.close()
        throw new EnvironmentError('download_failed')
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
        throw new EnvironmentError('download_failed')
      }
      await this.writeResponse(
        response,
        request.destination,
        maxBytes,
        request.signal,
      )
      return
    }
    throw new EnvironmentError('redirect_blocked')
  }

  private async writeResponse(
    response: HttpsAssetTransportResponse,
    destination: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const temp = `${destination}.part-${process.pid}-${randomBytes(5).toString('hex')}`
    let bytes = 0
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      await mkdir(dirname(destination), { recursive: true })
      handle = await open(temp, 'wx', 0o600)
      for await (const chunk of response.body) {
        if (signal.aborted) throw new EnvironmentError('cancelled')
        const buffer = Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > maxBytes) throw new EnvironmentError('download_failed')
        await handle.writeFile(buffer)
      }
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temp, destination)
    } catch (cause) {
      await handle?.close().catch(() => {})
      await rm(temp, { force: true }).catch(() => {})
      if (signal.aborted) throw new EnvironmentError('cancelled')
      throw cause instanceof EnvironmentError
        ? cause
        : new EnvironmentError('download_failed', { cause })
    } finally {
      try {
        response.close()
      } catch {
        // The body lifecycle is already terminal.
      }
    }
  }
}

export class NodeHttpsAssetTransport implements HttpsAssetTransport {
  async request(
    input: HttpsAssetTransportRequest,
  ): Promise<HttpsAssetTransportResponse> {
    return await new Promise((resolve, reject) => {
      const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
        callback(null, input.address, input.family)
      }
      const request = httpsRequest(
        input.url,
        {
          method: 'GET',
          headers: {
            accept: 'application/octet-stream',
            'user-agent': 'Emperor-Agent-Environment/1',
          },
          lookup: pinnedLookup,
          family: input.family,
          signal: input.signal,
        },
        (response) => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
            close: () => response.destroy(),
          })
        },
      )
      request.setTimeout(REQUEST_TIMEOUT_MS, () =>
        request.destroy(new Error('download request timed out')),
      )
      request.once('error', reject)
      request.end()
    })
  }
}

async function resolvePublicAddresses(
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

const blockedAddresses = createBlockedAddressList()

function isPublicIp(entry: ResolvedAddress): boolean {
  if (isIP(entry.address) !== entry.family) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(entry.address)
  if (mapped) return !blockedAddresses.check(mapped[1]!, 'ipv4')
  return !blockedAddresses.check(
    entry.address,
    entry.family === 4 ? 'ipv4' : 'ipv6',
  )
}

function createBlockedAddressList(): BlockList {
  const block = new BlockList()
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
    block.addSubnet(network, prefix, 'ipv4')
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
    ['2001:db8::', 32],
  ] as const)
    block.addSubnet(network, prefix, 'ipv6')
  return block
}

function parsePublicHttpsUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new EnvironmentError('redirect_blocked', { cause })
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.hostname.toLowerCase() === 'localhost' ||
    url.hostname.toLowerCase().endsWith('.local')
  )
    throw new EnvironmentError('redirect_blocked')
  return url
}

function validateMaxBytes(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DOWNLOAD_BYTES)
    throw new EnvironmentError('download_failed')
  return value
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
  if (!/^\d+$/.test(value)) throw new EnvironmentError('download_failed')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed))
    throw new EnvironmentError('download_failed')
  return parsed
}
