import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PublicHttpClient,
  type PublicHttpTransportRequest,
  type PublicHttpTransportResponse,
} from '../network/public-http'
import { WorkspaceReferenceService } from './references'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  'base64',
)

function reply(
  body: string | Uint8Array,
  type = 'text/html',
  status = 200,
): PublicHttpTransportResponse {
  return {
    statusCode: status,
    headers: { 'content-type': type },
    body: (async function* () {
      yield Buffer.from(body)
    })(),
    close() {},
  }
}

function fixture(
  options: {
    request?: (
      input: PublicHttpTransportRequest,
    ) => Promise<PublicHttpTransportResponse>
    network?: boolean
    maxEntries?: number
    authorizeSession?: (id: string) => void
    githubPreview?: ConstructorParameters<
      typeof WorkspaceReferenceService
    >[0]['githubPreview']
  } = {},
) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'emperor-reference-preview-'))
  mkdirSync(join(projectRoot, 'docs'))
  writeFileSync(join(projectRoot, 'docs', 'guide.md'), 'PRIVATE FILE CONTENT')
  const requests: PublicHttpTransportRequest[] = []
  const service = new WorkspaceReferenceService({
    resolveProject: (sessionId) => ({ sessionId, projectRoot }),
    maxEntries: options.maxEntries,
    authorizeSession: options.authorizeSession,
    githubPreview: options.githubPreview,
    webFetchClient:
      options.network === false
        ? null
        : new PublicHttpClient({
            resolve: async () => [{ address: '93.184.216.34', family: 4 }],
            transport: {
              request: async (input) => {
                requests.push(input)
                return options.request
                  ? options.request(input)
                  : reply('<title>Example</title>')
              },
            },
          }),
  })
  const resolve = (
    href = 'https://example.com/guide',
    sessionId = 's1',
    message = 'm1',
  ) =>
    service.resolve({
      sessionId,
      sourceMessageId: message,
      href,
      label: 'Guide',
    })
  return { service, requests, resolve, projectRoot }
}

const preview = (
  service: WorkspaceReferenceService,
  id: string,
  sessionId = 's1',
  signal?: AbortSignal,
) => service.preview({ sessionId, referenceId: id }, signal)

afterEach(() => vi.useRealTimers())

describe('lazy reference previews', () => {
  it('does not fetch on resolve and extracts inert HTML only on explicit preview', async () => {
    const { service, resolve, requests } = fixture({
      request: async () =>
        reply(`
      <title>Guide &amp; notes</title><meta name="description" content="A &quot;small&quot; guide">
      <script>throw new Error('must never execute')</script>
      <script>document.title = 'script title'</script>`),
    })
    const ref = resolve()
    expect(requests).toHaveLength(0)
    expect(await preview(service, ref.id)).toMatchObject({
      state: 'ready',
      title: 'Guide & notes',
      description: 'A "small" guide',
    })
    expect(requests.map((entry) => entry.url.toString())).toEqual([
      'https://example.com/guide',
    ])
  })

  it('returns only locally encoded, validated raster assets', async () => {
    const { service, resolve, requests } = fixture({
      request: async ({ url }) => {
        if (url.pathname === '/guide')
          return reply(
            '<title>Assets</title><meta property="og:image" content="/cover.png"><link rel="icon" href="/icon.png">',
          )
        return reply(PNG, 'image/png')
      },
    })
    const value = await preview(service, resolve().id)
    expect(value).toMatchObject({
      state: 'ready',
      iconDataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
      thumbnailDataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    })
    expect(JSON.stringify(value)).not.toContain('https://')
    expect(requests).toHaveLength(3)
    expect(
      requests.every((entry) =>
        Object.keys(entry.headers).every(
          (name) => !/cookie|authorization/i.test(name),
        ),
      ),
    ).toBe(true)
  })

  it.each([
    ['image/svg+xml', '<svg onload="alert(1)"></svg>'],
    ['image/png', '<html>not an image</html>'],
    ['text/html', PNG],
  ])(
    'omits unsafe or mismatched asset bytes with MIME %s',
    async (type, bytes) => {
      const { service, resolve } = fixture({
        request: async ({ url }) =>
          url.pathname === '/guide'
            ? reply(
                '<title>Safe text</title><meta property="og:image" content="/asset"><link rel="icon" href="/asset">',
              )
            : reply(bytes, type),
      })
      expect(await preview(service, resolve().id)).toMatchObject({
        state: 'ready',
        title: 'Safe text',
      })
      expect(await preview(service, resolve().id)).not.toHaveProperty(
        'iconDataUrl',
      )
      expect(await preview(service, resolve().id)).not.toHaveProperty(
        'thumbnailDataUrl',
      )
    },
  )

  it('rejects raster headers that declare excessive decoded dimensions', async () => {
    const oversized = Buffer.from(PNG)
    oversized.writeUInt32BE(100_000, 16)
    const { service, resolve } = fixture({
      request: async ({ url }) =>
        url.pathname === '/guide'
          ? reply(
              '<title>Small card</title><meta property="og:image" content="/image">',
            )
          : reply(oversized, 'image/png'),
    })
    const result = await preview(service, resolve().id)
    expect(result).toMatchObject({ state: 'ready', title: 'Small card' })
    expect(result).not.toHaveProperty('thumbnailDataUrl')
  })

  it('rejects a JPEG signature without a raster frame', async () => {
    const { service, resolve } = fixture({
      request: async ({ url }) =>
        url.pathname === '/guide'
          ? reply(
              '<title>Small card</title><meta property="og:image" content="/image">',
            )
          : reply(
              Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]),
              'image/jpeg',
            ),
    })
    expect(await preview(service, resolve().id)).not.toHaveProperty(
      'thumbnailDataUrl',
    )
  })

  it('checks asset redirects against the public HTTP client', async () => {
    const requests: PublicHttpTransportRequest[] = []
    const blocked = new PublicHttpClient({
      resolve: async (host) => [
        {
          address: host === '127.0.0.1' ? '127.0.0.1' : '93.184.216.34',
          family: 4,
        },
      ],
      transport: {
        request: async (input) => {
          requests.push(input)
          return input.url.pathname === '/guide'
            ? reply(
                '<title>Safe</title><meta property="og:image" content="/asset">',
              )
            : {
                ...reply('', 'text/html', 302),
                headers: { location: 'https://127.0.0.1/private' },
              }
        },
      },
    })
    const safe = new WorkspaceReferenceService({
      resolveProject: (sessionId) => ({ sessionId, projectRoot: '/tmp' }),
      webFetchClient: blocked,
    })
    const ref = safe.resolve({
      sessionId: 's1',
      sourceMessageId: 'm1',
      href: 'https://example.com/guide',
      label: 'Safe',
    })
    expect(await preview(safe, ref.id)).toMatchObject({
      state: 'ready',
      title: 'Safe',
    })
    expect(await preview(safe, ref.id)).not.toHaveProperty('thumbnailDataUrl')
    expect(requests.some((entry) => entry.url.hostname === '127.0.0.1')).toBe(
      false,
    )
  })

  it.each([
    [404, 'not_found'],
    [403, 'access_denied'],
    [500, 'http_error'],
  ])('degrades HTTP %s without response excerpts', async (code, reason) => {
    const { service, resolve } = fixture({
      request: async () => reply('SECRET ERROR PAGE', 'text/html', code),
    })
    const value = await preview(service, resolve().id)
    expect(value).toMatchObject({ state: 'unavailable', reason })
    expect(JSON.stringify(value)).not.toContain('SECRET')
  })

  it('bounds HTML, icon and thumbnail bytes independently', async () => {
    const large = fixture({
      request: async () => reply('x'.repeat(1024 * 1024 + 1)),
    })
    expect(await preview(large.service, large.resolve().id)).toMatchObject({
      state: 'unavailable',
      reason: 'response_too_large',
    })
    const assets = fixture({
      request: async ({ url }) =>
        url.pathname === '/guide'
          ? reply(
              '<title>Bounded</title><link rel="icon" href="/icon"><meta property="og:image" content="/cover">',
            )
          : reply(
              Buffer.concat([
                PNG,
                Buffer.alloc(
                  url.pathname === '/icon' ? 256 * 1024 : 512 * 1024,
                ),
              ]),
              'image/png',
            ),
    })
    const value = await preview(assets.service, assets.resolve().id)
    expect(value).toMatchObject({ state: 'ready', title: 'Bounded' })
    expect(value).not.toHaveProperty('iconDataUrl')
    expect(value).not.toHaveProperty('thumbnailDataUrl')
  })

  it('reports file metadata without reading file contents or the network', async () => {
    const { service, resolve, projectRoot, requests } = fixture()
    const ref = resolve(join(projectRoot, 'docs', 'guide.md'))
    expect(await preview(service, ref.id)).toMatchObject({
      state: 'ready',
      title: 'Guide',
      status: 'file',
    })
    expect(JSON.stringify(await preview(service, ref.id))).not.toContain(
      'PRIVATE FILE CONTENT',
    )
    expect(requests).toHaveLength(0)
    expect(await preview(service, resolve('docs/missing.md').id)).toMatchObject(
      { state: 'unavailable', status: 'missing' },
    )
  })

  it('handles absent network injection as typed unavailability', async () => {
    const { service, resolve } = fixture({ network: false })
    expect(await preview(service, resolve().id)).toMatchObject({
      state: 'unavailable',
      reason: 'network_unavailable',
    })
  })

  it('reauthorizes before cache access, isolates sessions and rejects evicted references', async () => {
    let revoked = false
    const { service, resolve, requests } = fixture({
      maxEntries: 2,
      authorizeSession: () => {
        if (revoked) throw new Error('SECRET ownership')
      },
    })
    const ref = resolve()
    await preview(service, ref.id)
    expect(await preview(service, ref.id, 's2')).toMatchObject({
      state: 'unavailable',
      reason: 'reference_unavailable',
    })
    const other = resolve('https://example.com/guide', 's2')
    expect(await preview(service, other.id, 's2')).toMatchObject({
      state: 'ready',
    })
    expect(requests).toHaveLength(2)
    revoked = true
    expect(await preview(service, ref.id)).toMatchObject({
      state: 'unavailable',
      reason: 'reference_unavailable',
    })
    revoked = false
    resolve('https://example.com/third', 's1', 'm3')
    expect(await preview(service, ref.id)).toMatchObject({
      state: 'unavailable',
      reason: 'reference_unavailable',
    })
    expect(requests).toHaveLength(2)
  })

  it('expires public metadata after ten minutes and updates its timestamp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { service, resolve, requests } = fixture()
    const ref = resolve()
    expect((await preview(service, ref.id)).updatedAt).toBe(10_000)
    vi.setSystemTime(609_999)
    expect((await preview(service, ref.id)).updatedAt).toBe(10_000)
    vi.setSystemTime(610_000)
    expect((await preview(service, ref.id)).updatedAt).toBe(610_000)
    expect(requests).toHaveLength(2)
  })

  it('evicts the least recently used public preview after 200 entries', async () => {
    const { service, resolve, requests } = fixture()
    const refs = Array.from({ length: 201 }, (_, index) =>
      resolve(`https://example.com/${index}`, 's1', `m${index}`),
    )
    for (const ref of refs.slice(0, 200)) await preview(service, ref.id)
    await preview(service, refs[0]!.id)
    await preview(service, refs[200]!.id)
    await preview(service, refs[0]!.id)
    expect(requests).toHaveLength(201)
    await preview(service, refs[1]!.id)
    expect(requests).toHaveLength(202)
  })

  it('keeps 200 cached previews for each session independently', async () => {
    const { service, resolve, requests } = fixture()
    const first = resolve('https://example.com/first', 's1', 'first')
    await preview(service, first.id)
    for (let index = 1; index < 200; index++)
      await preview(
        service,
        resolve(`https://example.com/${index}`, 's1', `a${index}`).id,
      )
    const other = resolve('https://example.com/first', 's2', 'first')
    await preview(service, other.id, 's2')
    for (let index = 1; index < 200; index++)
      await preview(
        service,
        resolve(`https://example.com/${index}`, 's2', `b${index}`).id,
        's2',
      )
    expect(requests).toHaveLength(400)
    await preview(service, first.id)
    await preview(service, other.id, 's2')
    expect(requests).toHaveLength(400)
  })

  it('caps active previews at four and expires each within its total eight second deadline', async () => {
    vi.useFakeTimers()
    const { service, resolve, requests } = fixture({
      request: () => new Promise(() => {}),
    })
    const pending = Array.from({ length: 4 }, (_, index) =>
      preview(
        service,
        resolve(`https://example.com/${index}`, 's1', `m${index}`).id,
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(
      await preview(service, resolve('https://example.com/fifth').id),
    ).toMatchObject({ state: 'unavailable', reason: 'busy' })
    expect(requests).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => ({
        state: 'error',
        reason: 'timeout',
        updatedAt: expect.any(Number),
      })),
    )
    expect(requests.every((entry) => entry.signal.aborted)).toBe(true)
    expect(
      await preview(service, resolve('https://example.com/sixth').id),
    ).toMatchObject({ state: 'unavailable', reason: 'busy' })
    expect(requests).toHaveLength(4)
  })

  it('respects cancellation and does not start work for an already cancelled call', async () => {
    const { service, resolve, requests } = fixture({
      request: () => new Promise(() => {}),
    })
    const controller = new AbortController()
    controller.abort()
    expect(
      await preview(service, resolve().id, 's1', controller.signal),
    ).toMatchObject({ state: 'error', reason: 'cancelled' })
    expect(requests).toHaveLength(0)
    const live = new AbortController()
    const pending = preview(service, resolve().id, 's1', live.signal)
    live.abort()
    expect(await pending).toMatchObject({ state: 'error', reason: 'cancelled' })
  })

  it('reauthorizes after the network read before releasing a result', async () => {
    let revoked = false
    const { service, resolve } = fixture({
      authorizeSession: () => {
        if (revoked) throw new Error('deleted')
      },
      request: async () => {
        revoked = true
        return reply('<title>Private now</title>')
      },
    })
    expect(await preview(service, resolve().id)).toMatchObject({
      state: 'unavailable',
      reason: 'reference_unavailable',
    })
  })

  it('routes only exact GitHub PR, Issue and Actions URLs through uncached authenticated reads', async () => {
    let enabled = true
    const subjects: string[] = []
    const { service, resolve, requests } = fixture({
      githubPreview: async (target, signal) => {
        if (!enabled)
          return {
            state: 'unavailable',
            reason: 'github_plugin_disabled',
            updatedAt: Date.now(),
          }
        expect(signal.aborted).toBe(false)
        subjects.push(`${target.kind}:${target.repo}:${target.number}`)
        return {
          state: 'ready',
          title: `Read ${subjects.length}`,
          status: 'OPEN',
          updatedAt: Date.now(),
        }
      },
    })
    const pr = resolve('https://github.com/acme/app/pull/42/files#diff')
    expect(await preview(service, pr.id)).toMatchObject({
      state: 'ready',
      title: 'Read 1',
    })
    expect(await preview(service, pr.id)).toMatchObject({
      state: 'ready',
      title: 'Read 2',
    })
    await preview(service, resolve('https://github.com/acme/app/issues/7').id)
    await preview(
      service,
      resolve('https://github.com/acme/app/actions/runs/123').id,
    )
    expect(subjects).toEqual([
      'pull_request:acme/app:42',
      'pull_request:acme/app:42',
      'issue:acme/app:7',
      'run:acme/app:123',
    ])
    expect(requests).toHaveLength(0)
    enabled = false
    expect(await preview(service, pr.id)).toMatchObject({
      state: 'unavailable',
      reason: 'github_plugin_disabled',
    })
    await preview(service, resolve('https://github.com/acme/app/commit/123').id)
    expect(requests).toHaveLength(1)
  })
})
