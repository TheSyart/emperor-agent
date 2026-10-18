import { describe, expect, it } from 'vitest'
import { WorkspaceReferenceService } from './references'
import {
  PublicHttpClient,
  type PublicHttpTransportRequest,
} from '../network/public-http'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  'base64',
)
function ico() {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = 1
  header[7] = 1
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(PNG.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, PNG])
}
function fixture(
  reply: (
    request: PublicHttpTransportRequest,
  ) =>
    | { body: string | Buffer; type?: string; status?: number }
    | Promise<{ body: string | Buffer; type?: string; status?: number }>,
) {
  let readable = true
  const calls: PublicHttpTransportRequest[] = []
  const service = new WorkspaceReferenceService({
    resolveProject: (sessionId) => ({ sessionId, projectRoot: '/unused' }),
    authorizeSession: () => {
      if (!readable) throw Error('archived')
    },
    webFetchClient: new PublicHttpClient({
      resolve: async (host) => [
        {
          address: host === 'private.test' ? '127.0.0.1' : '93.184.216.34',
          family: 4,
        },
      ],
      transport: {
        request: async (request) => {
          calls.push(request)
          const response = await reply(request)
          return {
            statusCode: response.status ?? 200,
            headers: { 'content-type': response.type ?? 'image/png' },
            body: (async function* () {
              yield Buffer.from(response.body)
            })(),
            close() {},
          }
        },
      },
    }),
  })
  const reference = (
    href = 'https://icons.example/article?secret=do-not-send',
    sessionId = 's1',
  ) => {
    const ref = service.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href,
      label: 'Site',
    })
    return { sessionId, referenceId: ref.id }
  }
  return {
    service,
    reference,
    calls,
    revoke: () => {
      readable = false
    },
  }
}
describe('reference website icons', () => {
  it('loads a real icon without reading the article or fetching metadata/thumbnail', async () => {
    const f = fixture(() => ({ body: PNG }))
    expect(await f.service.siteIcon(f.reference())).toMatchObject({
      state: 'ready',
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    })
    expect(f.calls.map((c) => c.url.toString())).toEqual([
      'https://icons.example/favicon.ico',
    ])
    expect(f.calls[0]!.headers).not.toHaveProperty('cookie')
  })
  it('accepts validated ICO containers and deduplicates paths and simultaneous requests by origin', async () => {
    const f = fixture(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { body: ico(), type: 'image/x-icon' }
    })
    const results = await Promise.all([
      f.service.siteIcon(f.reference()),
      f.service.siteIcon(f.reference('https://icons.example/other')),
    ])
    expect(results[0]).toMatchObject({
      state: 'ready',
      dataUrl: expect.stringMatching(/^data:image\/x-icon;base64,/),
    })
    expect(results[1]).toEqual(results[0])
    expect(f.calls).toHaveLength(1)
  })
  it('discovers a nonstandard homepage icon after conventional paths fail', async () => {
    const f = fixture((r) =>
      r.url.pathname === '/'
        ? {
            body: '<link rel="icon" href="/brand.png"><meta property="og:image" content="/large.jpg">',
            type: 'text/html',
          }
        : r.url.pathname === '/brand.png'
          ? { body: PNG }
          : { body: '', status: 404 },
    )
    expect(await f.service.siteIcon(f.reference())).toMatchObject({
      state: 'ready',
    })
    expect(f.calls.some((c) => c.url.pathname === '/brand.png')).toBe(true)
    expect(
      f.calls.some((c) => /article|large.jpg/.test(c.url.toString())),
    ).toBe(false)
  })
  it('uses only a public hostname for the icon-provider fallback, never the URL path or query', async () => {
    const f = fixture((r) =>
      r.url.hostname === 'icons.duckduckgo.com'
        ? { body: PNG }
        : { body: '', status: 404 },
    )
    expect(await f.service.siteIcon(f.reference())).toMatchObject({
      state: 'ready',
    })
    expect(f.calls.at(-1)!.url.toString()).toBe(
      'https://icons.duckduckgo.com/ip3/icons.example.ico',
    )
    expect(f.calls.every((c) => !c.url.toString().includes('secret'))).toBe(
      true,
    )
  })
  it('rechecks ownership before cache reads and after in-flight work', async () => {
    let complete!: () => void
    const f = fixture(async () => {
      await new Promise<void>((r) => {
        complete = r
      })
      return { body: PNG }
    })
    const ref = f.reference()
    const pending = f.service.siteIcon(ref)
    await new Promise((r) => setTimeout(r, 0))
    f.revoke()
    complete()
    expect(await pending).toMatchObject({
      state: 'unavailable',
      reason: 'reference_unavailable',
    })
    expect(await f.service.siteIcon(ref)).toMatchObject({
      state: 'unavailable',
      reason: 'reference_unavailable',
    })
    expect(
      await f.service.siteIcon({ ...ref, sessionId: 'foreign' }),
    ).toMatchObject({ state: 'unavailable' })
  })
  it('blocks private addresses before transport or provider fallback', async () => {
    const f = fixture(() => ({ body: PNG }))
    expect(
      await f.service.siteIcon(f.reference('https://private.test')),
    ).toMatchObject({ state: 'unavailable' })
    expect(f.calls).toHaveLength(0)
  })
  it('rejects malformed, oversized and non-raster image payloads', async () => {
    for (const [body, type] of [
      [Buffer.from('<svg onload="steal()"/>'), 'image/svg+xml'],
      [Buffer.alloc(256 * 1024 + 1), 'image/png'],
      [Buffer.from('not an ico'), 'image/x-icon'],
    ] as const) {
      const f = fixture(() => ({ body, type }))
      expect(await f.service.siteIcon(f.reference())).toMatchObject({
        state: 'unavailable',
      })
    }
  })
  it('limits simultaneous icon IO to four and caches failed lookups', async () => {
    let active = 0,
      peak = 0
    const f = fixture(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
      return { body: '', status: 404 }
    })
    const refs = Array.from({ length: 7 }, (_, i) =>
      f.reference(`https://site${i}.example`),
    )
    await Promise.all(refs.map((ref) => f.service.siteIcon(ref)))
    expect(peak).toBeLessThanOrEqual(4)
    const count = f.calls.length
    await f.service.siteIcon(refs[0]!)
    expect(f.calls).toHaveLength(count)
  })
})
