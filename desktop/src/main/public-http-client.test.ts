import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  createDesktopWebFetchClient,
  ElectronPublicHttpTransport,
  hasTrustedProxyRoute,
  type ElectronRequestLike,
  type ElectronRequestOptions,
} from './public-http-client'

class FakeRequest extends EventEmitter {
  aborted = false
  ended = false

  end(): void {
    this.ended = true
  }

  abort(): void {
    this.aborted = true
  }
}

describe('desktop public HTTP client', () => {
  it.each([
    ['DIRECT', false],
    ['direct', false],
    ['PROXY 127.0.0.1:7897', true],
    ['HTTPS 127.0.0.1:7897; DIRECT', true],
    ['SOCKS5 127.0.0.1:7897', true],
    ['', false],
  ])('classifies Electron proxy route %j', (route, expected) => {
    expect(hasTrustedProxyRoute(route)).toBe(expected)
  })

  it('uses the Electron network stack without credentials, cookies, custom protocols, or automatic redirects', async () => {
    const requests: ElectronRequestOptions[] = []
    const fake = new FakeRequest()
    const transport = new ElectronPublicHttpTransport((options) => {
      requests.push(options)
      return fake as ElectronRequestLike
    })

    const pending = transport.request({
      url: new URL('https://example.com/docs'),
      address: '198.18.0.10',
      family: 4,
      signal: new AbortController().signal,
      headers: { accept: 'text/plain' },
    })
    const body = new PassThrough() as PassThrough & {
      statusCode: number
      headers: Record<string, string | string[] | undefined>
    }
    body.statusCode = 200
    body.headers = { 'content-type': 'text/plain' }
    fake.emit('response', body)
    body.end('ok')

    const response = await pending

    expect(requests).toEqual([
      expect.objectContaining({
        url: 'https://example.com/docs',
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        useSessionCookies: false,
        bypassCustomProtocolHandlers: true,
        headers: expect.objectContaining({ accept: 'text/plain' }),
      }),
    ])
    expect(fake.ended).toBe(true)
    expect(response.statusCode).toBe(200)
    let content = ''
    for await (const chunk of response.body) content += Buffer.from(chunk)
    expect(content).toBe('ok')
  })

  it('returns a manual redirect to Core without following it inside Electron', async () => {
    const fake = new FakeRequest()
    const transport = new ElectronPublicHttpTransport(
      () => fake as ElectronRequestLike,
    )
    const pending = transport.request({
      url: new URL('https://first.example/start'),
      address: '198.18.0.11',
      family: 4,
      signal: new AbortController().signal,
      headers: {},
    })

    fake.emit('redirect', 302, 'GET', 'https://second.example/final', {
      location: ['https://second.example/final'],
    })

    const response = await pending
    expect(response).toMatchObject({
      statusCode: 302,
      headers: { location: ['https://second.example/final'] },
    })
    expect(fake.aborted).toBe(true)
  })

  it('aborts the Electron request with the turn signal', async () => {
    const fake = new FakeRequest()
    const controller = new AbortController()
    const transport = new ElectronPublicHttpTransport(
      () => fake as ElectronRequestLike,
    )
    const pending = transport.request({
      url: new URL('https://example.com/'),
      address: '198.18.0.12',
      family: 4,
      signal: controller.signal,
      headers: {},
    })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(fake.aborted).toBe(true)
  })

  it('keeps turn cancellation connected while the response body is streaming', async () => {
    const fake = new FakeRequest()
    const controller = new AbortController()
    const transport = new ElectronPublicHttpTransport(
      () => fake as ElectronRequestLike,
    )
    const pending = transport.request({
      url: new URL('https://example.com/stream'),
      address: '198.18.0.12',
      family: 4,
      signal: controller.signal,
      headers: {},
    })
    const body = new PassThrough() as PassThrough & {
      statusCode: number
      headers: Record<string, string | string[] | undefined>
    }
    body.statusCode = 200
    body.headers = {}
    fake.emit('response', body)
    await pending

    controller.abort()

    expect(fake.aborted).toBe(true)
    expect(body.destroyed).toBe(true)
  })

  it('enables synthetic routing only when Electron resolves a non-DIRECT proxy', async () => {
    const fake = new FakeRequest()
    const body = new PassThrough() as PassThrough & {
      statusCode: number
      headers: Record<string, string | string[] | undefined>
    }
    body.statusCode = 200
    body.headers = {}
    const client = createDesktopWebFetchClient({
      resolve: async () => [{ address: '198.18.0.13', family: 4 }],
      resolveProxy: async () => 'PROXY 127.0.0.1:7897; DIRECT',
      request: () => {
        queueMicrotask(() => {
          fake.emit('response', body)
          body.end('proxied')
        })
        return fake as ElectronRequestLike
      },
    })

    await expect(
      client.get({
        url: 'https://example.com/',
        protocols: ['https:'],
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 200 })
  })
})
