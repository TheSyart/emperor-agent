import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NodeHttpsAssetDownloader,
  type HttpsAssetTransport,
  type HttpsAssetTransportRequest,
  type HttpsAssetTransportResponse,
} from './download'

class FakeTransport implements HttpsAssetTransport {
  readonly requests: HttpsAssetTransportRequest[] = []
  readonly responses: HttpsAssetTransportResponse[] = []

  async request(
    request: HttpsAssetTransportRequest,
  ): Promise<HttpsAssetTransportResponse> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (!response) throw new Error('missing fake response')
    return response
  }
}

function response(
  opts: {
    status?: number
    location?: string
    body?: Buffer
    contentLength?: number
    onClose?: () => void
  } = {},
): HttpsAssetTransportResponse {
  const body = opts.body ?? Buffer.alloc(0)
  return {
    statusCode: opts.status ?? 200,
    headers: {
      ...(opts.location ? { location: opts.location } : {}),
      'content-length': String(opts.contentLength ?? body.byteLength),
    },
    body: (async function* () {
      yield body
    })(),
    close: opts.onClose ?? (() => {}),
  }
}

function destination(): string {
  return join(mkdtempSync(join(tmpdir(), 'emperor-download-')), 'asset.bin')
}

describe('NodeHttpsAssetDownloader', () => {
  it('rejects private DNS answers before opening a transport', async () => {
    const transport = new FakeTransport()
    const downloader = new NodeHttpsAssetDownloader({
      transport,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    })

    await expect(
      downloader.download({
        url: 'https://downloads.example.com/tool.pkg',
        destination: destination(),
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ environmentCode: 'redirect_blocked' })
    expect(transport.requests).toEqual([])
  })

  it('revalidates DNS on every redirect and blocks a private second hop', async () => {
    const transport = new FakeTransport()
    transport.responses.push(
      response({
        status: 302,
        location: 'https://private.example.com/final.pkg',
      }),
    )
    const downloader = new NodeHttpsAssetDownloader({
      transport,
      resolve: async (hostname) => [
        hostname === 'private.example.com'
          ? { address: '10.0.0.8', family: 4 as const }
          : { address: '93.184.216.34', family: 4 as const },
      ],
    })

    await expect(
      downloader.download({
        url: 'https://downloads.example.com/tool.pkg',
        destination: destination(),
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ environmentCode: 'redirect_blocked' })
    expect(transport.requests).toHaveLength(1)
  })

  it('enforces the streaming byte limit and removes partial files', async () => {
    const transport = new FakeTransport()
    transport.responses.push(response({ body: Buffer.alloc(2048) }))
    const target = destination()
    const downloader = new NodeHttpsAssetDownloader({
      transport,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await expect(
      downloader.download({
        url: 'https://downloads.example.com/tool.pkg',
        destination: target,
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ environmentCode: 'download_failed' })
    expect(existsSync(target)).toBe(false)
  })

  it('writes a successful response atomically through the pinned public address', async () => {
    const transport = new FakeTransport()
    transport.responses.push(response({ body: Buffer.from('verified bytes') }))
    const target = destination()
    const downloader = new NodeHttpsAssetDownloader({
      transport,
      resolve: async () => [
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
    })

    await downloader.download({
      url: 'https://downloads.example.com/tool.pkg',
      destination: target,
      maxBytes: 1024,
      signal: new AbortController().signal,
    })

    expect(readFileSync(target, 'utf8')).toBe('verified bytes')
    expect(transport.requests[0]).toMatchObject({
      address: '2606:2800:220:1:248:1893:25c8:1946',
      family: 6,
    })
    expect(
      readdirSync(join(target, '..')).some((name) => name.includes('.part-')),
    ).toBe(false)
  })

  it('closes the response when the local destination cannot be opened', async () => {
    const transport = new FakeTransport()
    let closed = false
    transport.responses.push(
      response({
        body: Buffer.from('bytes'),
        onClose: () => {
          closed = true
        },
      }),
    )
    const parentFile = destination()
    writeFileSync(parentFile, 'not a directory', 'utf8')
    const downloader = new NodeHttpsAssetDownloader({
      transport,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await expect(
      downloader.download({
        url: 'https://downloads.example.com/tool.pkg',
        destination: join(parentFile, 'asset.bin'),
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ environmentCode: 'download_failed' })
    expect(closed).toBe(true)
  })
})
