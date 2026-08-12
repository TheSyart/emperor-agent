import { describe, expect, it } from 'vitest'
import {
  isPublicHttpRedirectResponse,
  PublicHttpClient,
  type PublicHttpTransport,
  type PublicHttpTransportRequest,
  type PublicHttpTransportResponse,
} from './public-http'

class FakeTransport implements PublicHttpTransport {
  readonly requests: PublicHttpTransportRequest[] = []
  readonly responses: PublicHttpTransportResponse[] = []

  async request(
    request: PublicHttpTransportRequest,
  ): Promise<PublicHttpTransportResponse> {
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
    chunks?: Buffer[]
    contentLength?: number | null
    onClose?: () => void
  } = {},
): PublicHttpTransportResponse {
  const chunks = opts.chunks ?? [Buffer.from('ok')]
  const actualLength = chunks.reduce((total, chunk) => total + chunk.length, 0)
  return {
    statusCode: opts.status ?? 200,
    headers: {
      ...(opts.location ? { location: opts.location } : {}),
      ...(opts.contentLength === null
        ? {}
        : { 'content-length': String(opts.contentLength ?? actualLength) }),
    },
    body: (async function* () {
      for (const chunk of chunks) yield chunk
    })(),
    close: opts.onClose ?? (() => undefined),
  }
}

function request(url: string, maxBytes = 1024) {
  return {
    url,
    protocols: ['http:', 'https:'] as const,
    maxBytes,
    signal: new AbortController().signal,
  }
}

describe('PublicHttpClient', () => {
  it('pins a public resolved address and returns a bounded body', async () => {
    const transport = new FakeTransport()
    transport.responses.push(response({ chunks: [Buffer.from('public')] }))
    const client = new PublicHttpClient({
      transport,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    const result = await client.get(request('https://example.com/docs'))

    if (isPublicHttpRedirectResponse(result))
      throw new Error('unexpected redirect response')
    expect(Buffer.from(result.body).toString('utf8')).toBe('public')
    expect(transport.requests[0]).toMatchObject({
      address: '93.184.216.34',
      family: 4,
    })
  })

  it.each([
    ['0.0.0.0', 4],
    ['127.0.0.2', 4],
    ['169.254.169.254', 4],
    ['10.0.0.8', 4],
    ['172.16.0.1', 4],
    ['192.168.1.1', 4],
    ['::1', 6],
    ['fe80::1', 6],
    ['fc00::1', 6],
    ['::ffff:127.0.0.1', 6],
  ] as const)('blocks special-use address %s', async (address, family) => {
    const transport = new FakeTransport()
    const client = new PublicHttpClient({
      transport,
      resolve: async () => [{ address, family }],
    })

    await expect(
      client.get(request('http://service.example/')),
    ).rejects.toMatchObject({ code: 'blocked_address' })
    expect(transport.requests).toEqual([])
  })

  it('fails closed when DNS returns a mix of public and private addresses', async () => {
    const transport = new FakeTransport()
    const client = new PublicHttpClient({
      transport,
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ],
    })

    await expect(
      client.get(request('https://mixed.example/')),
    ).rejects.toMatchObject({ code: 'blocked_address' })
    expect(transport.requests).toEqual([])
  })

  it('routes a hostname with only proxy-synthetic addresses through the trusted proxy transport', async () => {
    const directTransport = new FakeTransport()
    const proxyTransport = new FakeTransport()
    proxyTransport.responses.push(
      response({ chunks: [Buffer.from('proxied')] }),
    )
    const checkedUrls: string[] = []
    const client = new PublicHttpClient({
      transport: directTransport,
      resolve: async () => [{ address: '198.18.0.102', family: 4 }],
      syntheticProxyRoute: {
        transport: proxyTransport,
        canRoute: async (url) => {
          checkedUrls.push(url.toString())
          return true
        },
      },
    })

    const result = await client.get(
      request('https://raw.githubusercontent.com/project/file'),
    )

    if (isPublicHttpRedirectResponse(result))
      throw new Error('unexpected redirect response')
    expect(Buffer.from(result.body).toString('utf8')).toBe('proxied')
    expect(checkedUrls).toEqual([
      'https://raw.githubusercontent.com/project/file',
    ])
    expect(directTransport.requests).toEqual([])
    expect(proxyTransport.requests).toHaveLength(1)
  })

  it.each([
    [
      'no trusted route',
      'https://example.com/',
      async (): Promise<boolean> => false,
    ],
    [
      'route detection failure',
      'https://example.com/',
      async (): Promise<boolean> => {
        throw new Error('proxy lookup failed')
      },
    ],
    ['IP literal', 'https://198.18.0.102/', async (): Promise<boolean> => true],
  ] as const)(
    'blocks proxy-synthetic addresses for %s',
    async (_label, url, canRoute) => {
      const proxyTransport = new FakeTransport()
      const client = new PublicHttpClient({
        transport: new FakeTransport(),
        resolve: async () => [{ address: '198.18.0.102', family: 4 }],
        syntheticProxyRoute: { transport: proxyTransport, canRoute },
      })

      await expect(client.get(request(url))).rejects.toMatchObject({
        code: 'blocked_address',
      })
      expect(proxyTransport.requests).toEqual([])
    },
  )

  it('blocks mixed public and proxy-synthetic DNS answers', async () => {
    const proxyTransport = new FakeTransport()
    const client = new PublicHttpClient({
      transport: new FakeTransport(),
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '198.18.0.102', family: 4 },
      ],
      syntheticProxyRoute: {
        transport: proxyTransport,
        canRoute: async () => true,
      },
    })

    await expect(
      client.get(request('https://mixed.example/')),
    ).rejects.toMatchObject({ code: 'blocked_address' })
    expect(proxyTransport.requests).toEqual([])
  })

  it('revalidates the trusted proxy route for every synthetic redirect hop', async () => {
    const proxyTransport = new FakeTransport()
    proxyTransport.responses.push(
      response({ status: 302, location: 'https://second.example/final' }),
    )
    const checkedHosts: string[] = []
    const client = new PublicHttpClient({
      transport: new FakeTransport(),
      resolve: async () => [{ address: '198.18.0.102', family: 4 }],
      syntheticProxyRoute: {
        transport: proxyTransport,
        canRoute: async (url) => {
          checkedHosts.push(url.hostname)
          return url.hostname === 'first.example'
        },
      },
    })

    await expect(
      client.get(request('https://first.example/start')),
    ).rejects.toMatchObject({ code: 'blocked_address' })
    expect(checkedHosts).toEqual(['first.example', 'second.example'])
    expect(proxyTransport.requests).toHaveLength(1)
  })

  it('rejects credentials, localhost, local domains, and unapproved protocols before DNS', async () => {
    let resolutions = 0
    const client = new PublicHttpClient({
      resolve: async () => {
        resolutions += 1
        return [{ address: '93.184.216.34', family: 4 }]
      },
      transport: new FakeTransport(),
    })

    for (const url of [
      'http://user:secret@example.com/',
      'http://localhost/',
      'http://printer.local/',
      'file:///tmp/private',
    ])
      await expect(client.get(request(url))).rejects.toMatchObject({
        code: 'blocked_url',
      })
    expect(resolutions).toBe(0)
  })

  it('re-resolves every redirect and blocks a private second hop', async () => {
    const transport = new FakeTransport()
    let firstClosed = 0
    transport.responses.push(
      response({
        status: 302,
        location: 'http://private.example/final',
        onClose: () => {
          firstClosed += 1
        },
      }),
    )
    const client = new PublicHttpClient({
      transport,
      resolve: async (hostname) => [
        hostname === 'private.example'
          ? { address: '10.0.0.8', family: 4 as const }
          : { address: '93.184.216.34', family: 4 as const },
      ],
    })

    await expect(
      client.get(request('http://public.example/start')),
    ).rejects.toMatchObject({ code: 'blocked_address' })
    expect(transport.requests).toHaveLength(1)
    expect(firstClosed).toBe(1)
  })

  it('returns a cross-origin redirect without requesting the second host in manual mode', async () => {
    const transport = new FakeTransport()
    transport.responses.push(
      response({
        status: 302,
        location: 'https://other.example/final',
      }),
    )
    const client = new PublicHttpClient({
      transport,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await expect(
      client.get({
        ...request('https://first.example/start'),
        redirectMode: 'manual_cross_origin',
      }),
    ).resolves.toEqual({
      kind: 'redirect',
      originalUrl: 'https://first.example/start',
      redirectUrl: 'https://other.example/final',
      status: 302,
    })
    expect(transport.requests).toHaveLength(1)
  })

  it('follows same-origin redirects in manual cross-origin mode', async () => {
    const transport = new FakeTransport()
    transport.responses.push(
      response({ status: 302, location: '/final' }),
      response({ chunks: [Buffer.from('done')] }),
    )
    const client = new PublicHttpClient({
      transport,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    const result = await client.get({
      ...request('https://first.example/start'),
      redirectMode: 'manual_cross_origin',
    })

    expect(result).toMatchObject({
      url: 'https://first.example/final',
      status: 200,
    })
    expect(transport.requests).toHaveLength(2)
  })

  it('enforces the redirect limit and closes every redirected response', async () => {
    const transport = new FakeTransport()
    let closed = 0
    for (let index = 0; index < 3; index += 1)
      transport.responses.push(
        response({
          status: 302,
          location: `/hop-${index + 1}`,
          onClose: () => {
            closed += 1
          },
        }),
      )
    const client = new PublicHttpClient({
      transport,
      maxRedirects: 2,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await expect(
      client.get(request('https://example.com/start')),
    ).rejects.toMatchObject({ code: 'redirect_limit' })
    expect(closed).toBe(3)
  })

  it('rejects declared and streamed bodies over the byte limit', async () => {
    const transport = new FakeTransport()
    let closed = 0
    transport.responses.push(
      response({
        contentLength: 2048,
        onClose: () => {
          closed += 1
        },
      }),
      response({
        contentLength: null,
        chunks: [Buffer.alloc(700), Buffer.alloc(700)],
        onClose: () => {
          closed += 1
        },
      }),
    )
    const client = new PublicHttpClient({
      transport,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await expect(
      client.get(request('https://example.com/a', 1024)),
    ).rejects.toMatchObject({ code: 'response_too_large' })
    await expect(
      client.get(request('https://example.com/b', 1024)),
    ).rejects.toMatchObject({ code: 'response_too_large' })
    expect(closed).toBe(2)
  })

  it('rejects a request cancelled before DNS or transport work', async () => {
    const transport = new FakeTransport()
    const controller = new AbortController()
    controller.abort()
    const client = new PublicHttpClient({
      transport,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await expect(
      client.get({
        ...request('https://example.com'),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(transport.requests).toEqual([])
  })
})
