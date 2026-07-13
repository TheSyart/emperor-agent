import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  NodePublicHttpTransport,
  PublicHttpClient,
  PublicHttpError,
  type PublicHttpOpenedResponse,
  type PublicHttpTransport,
  type PublicHttpTransportRequest,
  type PublicHttpTransportResponse,
  type ResolvedAddress as PublicResolvedAddress,
} from '../network/public-http'
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

export type ResolvedAddress = PublicResolvedAddress
export type HttpsAssetTransportRequest = PublicHttpTransportRequest
export type HttpsAssetTransportResponse = PublicHttpTransportResponse
export type HttpsAssetTransport = PublicHttpTransport

export interface NodeHttpsAssetDownloaderOptions {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  transport?: HttpsAssetTransport
}

export class NodeHttpsAssetDownloader implements AssetDownloader {
  private readonly client: PublicHttpClient

  constructor(opts: NodeHttpsAssetDownloaderOptions = {}) {
    this.client = new PublicHttpClient({
      resolve: opts.resolve,
      transport: opts.transport ?? new NodeHttpsAssetTransport(),
      maxRedirects: MAX_REDIRECTS,
    })
  }

  async download(request: AssetDownloadRequest): Promise<void> {
    const maxBytes = validateMaxBytes(request.maxBytes)
    let response: PublicHttpOpenedResponse
    try {
      response = await this.client.open({
        url: request.url,
        protocols: ['https:'],
        maxBytes,
        signal: request.signal,
        headers: {
          accept: 'application/octet-stream',
          'user-agent': 'Emperor-Agent-Environment/1',
        },
      })
    } catch (cause) {
      throw mapDownloadError(cause, request.signal)
    }

    if (response.statusCode !== 200) {
      response.close()
      throw new EnvironmentError('download_failed')
    }
    await this.writeResponse(
      response,
      request.destination,
      maxBytes,
      request.signal,
    )
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

export class NodeHttpsAssetTransport extends NodePublicHttpTransport {
  constructor() {
    super(REQUEST_TIMEOUT_MS)
  }
}

function validateMaxBytes(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DOWNLOAD_BYTES)
    throw new EnvironmentError('download_failed')
  return value
}

function mapDownloadError(
  cause: unknown,
  signal: AbortSignal,
): EnvironmentError {
  if (signal.aborted) return new EnvironmentError('cancelled', { cause })
  if (!(cause instanceof PublicHttpError))
    return cause instanceof EnvironmentError
      ? cause
      : new EnvironmentError('download_failed', { cause })
  switch (cause.code) {
    case 'blocked_url':
    case 'blocked_address':
    case 'redirect_limit':
      return new EnvironmentError('redirect_blocked', { cause })
    case 'dns_failed':
      return new EnvironmentError('network_unavailable', { cause })
    case 'cancelled':
      return new EnvironmentError('cancelled', { cause })
    default:
      return new EnvironmentError('download_failed', { cause })
  }
}
