import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  UpdateHttp,
  UpdateUrlPolicy,
  feedOverrideUrl,
  type UpdateTransport,
  type UpdateTransportRequest,
} from './http'
import { UpdateError } from './errors'

// REL-02 security: in production every hop is https on GitHub's release
// hosts; the only other origin is an explicit loopback test feed.

function response(
  statusCode: number,
  body: string | Uint8Array = '',
  headers: Record<string, string> = {},
) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  return {
    statusCode,
    headers,
    body: (async function* () {
      if (bytes.byteLength) yield bytes
    })(),
    close: () => {},
  }
}

describe('UpdateUrlPolicy', () => {
  it('production: https on api.github.com, github.com and the release asset hosts only', () => {
    const policy = new UpdateUrlPolicy(null)
    for (const url of [
      'https://api.github.com/repos/TheSyart/emperor-agent/releases',
      'https://github.com/TheSyart/emperor-agent/releases/download/v0.2.1/a.dmg',
      'https://objects.githubusercontent.com/github-production-release-asset/1',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1',
      'https://github-releases.githubusercontent.com/1',
    ])
      expect(policy.allows(new URL(url)), url).toBe(true)
    for (const url of [
      'http://api.github.com/repos/TheSyart/emperor-agent/releases',
      'https://api.github.com:8443/repos',
      'https://user:pw@github.com/TheSyart',
      'https://raw.githubusercontent.com/TheSyart/x',
      'https://github.com.evil.example/',
      'https://evil.example/',
      'http://127.0.0.1:8080/releases',
    ])
      expect(policy.allows(new URL(url)), url).toBe(false)
  })

  it('a test feed adds its own loopback origin and nothing else', () => {
    const policy = new UpdateUrlPolicy(
      new URL('http://127.0.0.1:41234/repos/TheSyart/emperor-agent/releases'),
    )
    expect(
      policy.allows(new URL('http://127.0.0.1:41234/download/a.dmg')),
    ).toBe(true)
    expect(
      policy.allows(new URL('http://127.0.0.1:41235/download/a.dmg')),
    ).toBe(false)
    expect(policy.allows(new URL('http://localhost:41234/a.dmg'))).toBe(false)
    expect(
      policy.allows(new URL('https://api.github.com/repos/TheSyart/x')),
    ).toBe(true)
  })

  it('EMPEROR_UPDATE_FEED_URL must be a loopback http(s) address', () => {
    expect(feedOverrideUrl(undefined)).toBeNull()
    expect(feedOverrideUrl('')).toBeNull()
    expect(feedOverrideUrl('http://127.0.0.1:8765/releases')?.href).toBe(
      'http://127.0.0.1:8765/releases',
    )
    expect(feedOverrideUrl('http://localhost:8765/releases')?.host).toBe(
      'localhost:8765',
    )
    expect(feedOverrideUrl('http://[::1]:8765/releases')?.hostname).toBe(
      '[::1]',
    )
    for (const bad of [
      'https://evil.example/releases',
      'https://api.github.com/repos/someone/fork/releases',
      'file:///tmp/releases.json',
      'http://user:pw@127.0.0.1:8765/',
      'not a url',
    ])
      expect(() => feedOverrideUrl(bad), bad).toThrow(UpdateError)
  })
})

describe('UpdateHttp', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('follows a redirect to a release asset host, re-checking every hop', async () => {
    const seen: string[] = []
    const transport: UpdateTransport = async (request) => {
      seen.push(request.url.href)
      if (request.url.hostname === 'github.com')
        return response(302, '', {
          location:
            'https://objects.githubusercontent.com/github-production-release-asset/9?sig=1',
        })
      return response(200, 'payload')
    }
    const http = new UpdateHttp({
      transport,
      policy: new UpdateUrlPolicy(null),
      userAgent: 'Emperor-Agent/0.2.0',
    })
    const body = await http.getBytes(
      new URL(
        'https://github.com/TheSyart/emperor-agent/releases/download/v0.2.1/SHA256SUMS.txt',
      ),
      { accept: 'text/plain', maxBytes: 1024 },
    )
    expect(Buffer.from(body).toString()).toBe('payload')
    expect(seen).toEqual([
      'https://github.com/TheSyart/emperor-agent/releases/download/v0.2.1/SHA256SUMS.txt',
      'https://objects.githubusercontent.com/github-production-release-asset/9?sig=1',
    ])
  })

  it('refuses a redirect off the allowed hosts or down to http', async () => {
    for (const location of [
      'https://evil.example/a.dmg',
      'http://objects.githubusercontent.com/a.dmg',
    ]) {
      const calls: string[] = []
      const http = new UpdateHttp({
        transport: async (request) => {
          calls.push(request.url.href)
          return response(302, '', { location })
        },
        policy: new UpdateUrlPolicy(null),
        userAgent: 'Emperor-Agent/0.2.0',
      })
      await expect(
        http.getBytes(new URL('https://github.com/TheSyart/x'), {
          accept: '*/*',
          maxBytes: 10,
        }),
      ).rejects.toMatchObject({ code: 'update_blocked_url' })
      expect(calls, location).toHaveLength(1)
    }
  })

  it('never sends a request to a URL the policy refuses', async () => {
    let calls = 0
    const http = new UpdateHttp({
      transport: async () => {
        calls += 1
        return response(200, 'x')
      },
      policy: new UpdateUrlPolicy(null),
      userAgent: 'Emperor-Agent/0.2.0',
    })
    await expect(
      http.getBytes(new URL('https://evil.example/releases'), {
        accept: '*/*',
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'update_blocked_url' })
    expect(calls).toBe(0)
  })

  it('8 · sends only accept, user-agent and the API version: no cookie, token or id', async () => {
    const requests: UpdateTransportRequest[] = []
    const http = new UpdateHttp({
      transport: async (request) => {
        requests.push(request)
        return response(200, '[]')
      },
      policy: new UpdateUrlPolicy(null),
      userAgent: 'Emperor-Agent/0.2.0',
    })
    await http.getBytes(
      new URL('https://api.github.com/repos/TheSyart/emperor-agent/releases'),
      { accept: 'application/vnd.github+json', maxBytes: 100, api: true },
    )
    expect(requests[0]!.headers).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'Emperor-Agent/0.2.0',
      'x-github-api-version': '2022-11-28',
    })
  })

  it('fails an HTTP error or an oversized body with a Chinese reason', async () => {
    const http = new UpdateHttp({
      transport: async (request) =>
        request.url.pathname.endsWith('big')
          ? response(200, 'x'.repeat(20))
          : response(403, 'rate limited'),
      policy: new UpdateUrlPolicy(null),
      userAgent: 'Emperor-Agent/0.2.0',
    })
    await expect(
      http.getBytes(new URL('https://api.github.com/repos/x'), {
        accept: '*/*',
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({
      code: 'update_network_failed',
      message: expect.stringContaining('403'),
    })
    await expect(
      http.getBytes(new URL('https://api.github.com/big'), {
        accept: '*/*',
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'update_too_large' })
  })

  it('streams a download to disk with progress and returns its SHA-256', async () => {
    dir = await mkdtemp(join(tmpdir(), 'emperor-update-http-'))
    const bytes = Buffer.alloc(300_000, 7)
    const http = new UpdateHttp({
      transport: async () => ({
        statusCode: 200,
        headers: { 'content-length': String(bytes.byteLength) },
        body: (async function* () {
          for (let at = 0; at < bytes.byteLength; at += 100_000)
            yield bytes.subarray(at, at + 100_000)
        })(),
        close: () => {},
      }),
      policy: new UpdateUrlPolicy(null),
      userAgent: 'Emperor-Agent/0.2.0',
    })
    const progress: number[] = []
    const file = join(dir, 'a.dmg')
    const digest = await http.downloadTo(
      new URL('https://github.com/a'),
      file,
      {
        maxBytes: bytes.byteLength,
        expectedBytes: bytes.byteLength,
        onProgress: (received) => progress.push(received),
      },
    )
    expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect((await readFile(file)).equals(bytes)).toBe(true)
    expect(progress.at(-1)).toBe(bytes.byteLength)
  })

  it('a download longer or shorter than the release says is refused and removed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'emperor-update-http-'))
    for (const [size, code] of [
      [12, 'update_too_large'],
      [5, 'update_network_failed'],
    ] as const) {
      const http = new UpdateHttp({
        transport: async () => response(200, 'x'.repeat(size)),
        policy: new UpdateUrlPolicy(null),
        userAgent: 'Emperor-Agent/0.2.0',
      })
      const file = join(dir, `${size}.dmg`)
      await expect(
        http.downloadTo(new URL('https://github.com/a'), file, {
          maxBytes: 10,
          expectedBytes: 10,
        }),
      ).rejects.toMatchObject({ code })
    }
    expect(await readdir(dir)).toEqual([])
  })

  it('gives up on a download that stops sending data', async () => {
    dir = await mkdtemp(join(tmpdir(), 'emperor-update-http-'))
    const http = new UpdateHttp({
      transport: async (request) => ({
        statusCode: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from('ab')
          await new Promise((_resolve, reject) =>
            request.signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            ),
          )
        })(),
        close: () => {},
      }),
      policy: new UpdateUrlPolicy(null),
      userAgent: 'Emperor-Agent/0.2.0',
      idleTimeoutMs: 30,
    })
    await expect(
      http.downloadTo(new URL('https://github.com/a'), join(dir, 'a.dmg'), {
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'update_network_failed' })
    expect(await readdir(dir)).toEqual([])
  })
})
