import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CoreUpdateService, type CoreUpdateServiceDeps } from './service'
import type { UpdateTransport } from './http'
import type { UpdateAttestationResult, UpdateStatus } from './types'

// REL-02 card tests 1–8 against a local fake GitHub (a real HTTP server on
// 127.0.0.1, reached through the explicit test-feed override) or an
// injected transport; never the real GitHub.

const DAY = 24 * 60 * 60 * 1000
const REPO_PATH = '/repos/TheSyart/emperor-agent/releases'

interface FakeRelease {
  tag: string
  dmg?: Buffer
  /** What SHA256SUMS.txt claims for the DMG (default: the real digest). */
  claimedDigest?: string
  body?: string
}

interface FakeGitHub {
  url: string
  requests: Array<{ path: string; headers: IncomingHttpHeaders }>
  releases: FakeRelease[]
  close(): Promise<void>
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fakeGitHub(releases: FakeRelease[]): Promise<FakeGitHub> {
  const requests: FakeGitHub['requests'] = []
  const state = { releases }
  let origin = ''
  const dmgName = (tag: string) =>
    `Emperor-Agent-${tag.slice(1)}${tag.includes('-preview.') ? '-UNSIGNED-PREVIEW' : ''}-macos-arm64.dmg`
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/'
    requests.push({ path, headers: req.headers })
    if (path.startsWith(REPO_PATH)) {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify(
          state.releases.map((item) => {
            const names = [dmgName(item.tag), 'SHA256SUMS.txt']
            return {
              tag_name: item.tag,
              name: `Emperor Agent ${item.tag}`,
              draft: false,
              prerelease: item.tag.includes('-preview.'),
              html_url: `https://github.com/TheSyart/emperor-agent/releases/tag/${item.tag}`,
              published_at: '2026-10-21T08:00:00Z',
              body: item.body ?? '',
              assets: names.map((name) => ({
                name,
                size:
                  name === 'SHA256SUMS.txt'
                    ? 200
                    : (item.dmg ?? Buffer.from('dmg')).byteLength,
                browser_download_url: `${origin}/download/${item.tag}/${name}`,
              })),
            }
          }),
        ),
      )
      return
    }
    const match = /^\/download\/([^/]+)\/([^?]+)/.exec(path)
    const item = match && state.releases.find((r) => r.tag === match[1])
    if (!match || !item) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const dmg = item.dmg ?? Buffer.from('dmg')
    if (match[2] === 'SHA256SUMS.txt') {
      res.end(
        `${item.claimedDigest ?? sha256(dmg)}  ${dmgName(item.tag)}\n${'0'.repeat(64)}  SHA256SUMS-other.txt\n`,
      )
      return
    }
    if (match[2] === dmgName(item.tag)) {
      // Like GitHub: the download link redirects to the asset host.
      if (!path.includes('?served')) {
        res.statusCode = 302
        res.setHeader('location', `${path}?served=1`)
        res.end()
        return
      }
      res.setHeader('content-length', String(dmg.byteLength))
      res.end(dmg)
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${origin}${REPO_PATH}`,
    requests,
    get releases() {
      return state.releases
    },
    set releases(next) {
      state.releases = next
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Timers the test moves by hand; `advance` runs what falls due, in order. */
class ManualClock {
  current = 1_000_000
  private timers = new Map<number, { at: number; fn: () => void }>()
  private next = 1

  now = (): number => this.current
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.next++
    this.timers.set(id, { at: this.current + ms, fn })
    return id
  }
  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number)
  }
  pending(): number {
    return this.timers.size
  }
  async advance(ms: number): Promise<void> {
    const end = this.current + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.current = due[1].at
      due[1].fn()
      await flush()
    }
    this.current = end
    await flush()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r))
}

interface Harness {
  service: CoreUpdateService
  events: Array<Record<string, unknown>>
  revealed: string[]
  quarantined: string[]
  settings: { enabled: boolean }
  downloads: string
  temp: string
  clock: ManualClock
}

let dirs: string[] = []
let servers: FakeGitHub[] = []

beforeEach(() => {
  dirs = []
  servers = []
})

afterEach(async () => {
  for (const server of servers) await server.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function harness(
  options: {
    appVersion?: string
    feed?: string
    transport?: UpdateTransport
    enabled?: boolean
    automatic?: boolean
    attestation?: (file: string) => Promise<UpdateAttestationResult>
  } = {},
): Promise<Harness> {
  const downloads = await mkdtemp(join(tmpdir(), 'emperor-update-dl-'))
  const temp = await mkdtemp(join(tmpdir(), 'emperor-update-tmp-'))
  dirs.push(downloads, temp)
  const events: Array<Record<string, unknown>> = []
  const revealed: string[] = []
  const quarantined: string[] = []
  const settings = { enabled: options.enabled ?? true }
  const clock = new ManualClock()
  const deps: CoreUpdateServiceDeps = {
    appVersion: options.appVersion ?? '0.2.0',
    host: {
      electronVersion: '42.2.0',
      arch: 'arm64',
      downloadsDir: downloads,
      tempDir: temp,
      reveal: (path) => revealed.push(path),
      markQuarantine: (path) => {
        quarantined.push(path)
      },
      feedOverride: options.feed ?? null,
      automatic: options.automatic ?? true,
      ...(options.transport ? { transport: options.transport } : {}),
    },
    settings: {
      load: async () => settings.enabled,
      save: async (enabled) => {
        settings.enabled = enabled
      },
    },
    emit: (event) => events.push(event),
    ...(options.attestation ? { attestation: options.attestation } : {}),
    clock,
  }
  return {
    service: new CoreUpdateService(deps),
    events,
    revealed,
    quarantined,
    settings,
    downloads,
    temp,
    clock,
  }
}

async function github(releases: FakeRelease[]): Promise<FakeGitHub> {
  const server = await fakeGitHub(releases)
  servers.push(server)
  return server
}

async function waitFor(
  service: CoreUpdateService,
  done: (status: UpdateStatus) => boolean,
): Promise<UpdateStatus> {
  for (let i = 0; i < 400; i += 1) {
    const status = service.status()
    if (done(status)) return status
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out: ${JSON.stringify(service.status())}`)
}

function failingTransport(calls: { count: number }): UpdateTransport {
  return async () => {
    calls.count += 1
    throw new Error('getaddrinfo ENOTFOUND api.github.com')
  }
}

describe('REL-02 update check', () => {
  it('1 · a newer release is announced once and shown in the status', async () => {
    const feed = await github([{ tag: 'v0.2.1' }, { tag: 'v0.2.0' }])
    const { service, events } = await harness({ feed: feed.url })
    await service.start()
    const status = await service.check()
    expect(status.available).toMatchObject({
      version: '0.2.1',
      tag: 'v0.2.1',
      notesUrl: 'https://github.com/TheSyart/emperor-agent/releases/tag/v0.2.1',
      asset: { name: 'Emperor-Agent-0.2.1-macos-arm64.dmg' },
    })
    expect(status.lastCheckedAt).not.toBeNull()
    expect(status.lastError).toBeNull()
    // The renderer's bell listens for this one event.
    expect(events.filter((e) => e.event === 'update_available')).toEqual([
      {
        event: 'update_available',
        version: '0.2.1',
        tag: 'v0.2.1',
        notesUrl:
          'https://github.com/TheSyart/emperor-agent/releases/tag/v0.2.1',
      },
    ])
    await service.check()
    expect(events.filter((e) => e.event === 'update_available')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ event: 'update_status' })
    service.close()
  })

  it('2 · the same or an older version shows nothing', async () => {
    const feed = await github([{ tag: 'v0.2.0' }, { tag: 'v0.1.9' }])
    const { service, events } = await harness({ feed: feed.url })
    await service.start()
    const status = await service.check()
    expect(status.available).toBeNull()
    expect(status.lastCheckedAt).not.toBeNull()
    expect(events.some((e) => e.event === 'update_available')).toBe(false)
    service.close()
  })

  it('3 · channels: a preview build is offered previews and stables, a stable build only stables', async () => {
    const releases = [{ tag: 'v0.3.0-preview.1' }, { tag: 'v0.2.0' }]
    const feed = await github(releases)
    const preview = await harness({
      feed: feed.url,
      appVersion: '0.2.0-preview.4',
    })
    await preview.service.start()
    expect((await preview.service.check()).available?.version).toBe(
      '0.3.0-preview.1',
    )
    expect(preview.service.status().channel).toBe('preview')
    preview.service.close()

    const stable = await harness({ feed: feed.url, appVersion: '0.2.0' })
    await stable.service.start()
    expect((await stable.service.check()).available).toBeNull()
    expect(stable.service.status().channel).toBe('stable')
    feed.releases = [{ tag: 'v0.3.0-preview.1' }, { tag: 'v0.2.1' }]
    expect((await stable.service.check()).available?.version).toBe('0.2.1')
    stable.service.close()

    // A preview build still gets the stable that follows its previews.
    const late = await harness({
      feed: feed.url,
      appVersion: '0.2.1-preview.3',
    })
    await late.service.start()
    feed.releases = [{ tag: 'v0.2.1' }]
    expect((await late.service.check()).available?.version).toBe('0.2.1')
    late.service.close()
  })

  it('6 · with the switch off nothing is requested, not even by hand', async () => {
    const calls = { count: 0 }
    const { service, clock, settings } = await harness({
      transport: failingTransport(calls),
      enabled: false,
    })
    await service.start()
    await clock.advance(3 * DAY)
    expect(calls.count).toBe(0)
    expect(clock.pending()).toBe(0)
    await expect(service.check()).rejects.toMatchObject({
      code: 'update_check_disabled',
    })
    await expect(service.download()).rejects.toMatchObject({
      code: 'update_check_disabled',
    })
    expect(calls.count).toBe(0)

    // On: the first check 30 s later. Off again: the timer goes.
    await service.setEnabled(true)
    expect(settings.enabled).toBe(true)
    await clock.advance(29_000)
    expect(calls.count).toBe(0)
    await service.setEnabled(false)
    expect(settings.enabled).toBe(false)
    await clock.advance(3 * DAY)
    expect(calls.count).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(service.status()).toMatchObject({ enabled: false, available: null })
    service.close()
  })

  it('7 · a failing network is retried quietly, at most 3 times in 24 hours', async () => {
    const calls = { count: 0 }
    const { service, clock, events } = await harness({
      transport: failingTransport(calls),
    })
    await service.start()
    await clock.advance(29_999)
    expect(calls.count).toBe(0)
    await clock.advance(1)
    expect(calls.count).toBe(1) // 30 s after start
    await clock.advance(DAY - 30_000 - 1)
    expect(calls.count).toBe(4) // + 3 retries inside the first 24 hours
    await clock.advance(30_000 + 1)
    expect(calls.count).toBe(5) // the next day's check
    await clock.advance(DAY)
    expect(calls.count).toBeLessThanOrEqual(9)
    expect(calls.count).toBeGreaterThanOrEqual(8)
    const status = service.status()
    expect(status.lastError).toMatchObject({ code: 'update_network_failed' })
    expect(status.available).toBeNull()
    // Quiet: status updates only — no announcement, no error event.
    expect(new Set(events.map((event) => event.event))).toEqual(
      new Set(['update_status']),
    )
    service.close()
    expect(clock.pending()).toBe(0)
  })

  it('a success after failures ends the retries and waits a day', async () => {
    let fail = true
    const calls = { count: 0 }
    const { service, clock } = await harness({
      transport: async () => {
        calls.count += 1
        if (fail) throw new Error('ECONNRESET')
        return {
          statusCode: 200,
          headers: {},
          body: (async function* () {
            yield Buffer.from('[]')
          })(),
          close: () => {},
        }
      },
    })
    await service.start()
    await clock.advance(30_000)
    expect(calls.count).toBe(1)
    fail = false
    await clock.advance(10 * 60_000)
    expect(calls.count).toBe(2)
    expect(service.status().lastError).toBeNull()
    await clock.advance(DAY - 10 * 60_000 - 30_000 - 1)
    expect(calls.count).toBe(2)
    await clock.advance(30_001)
    expect(calls.count).toBe(3)
    service.close()
  })

  it('8 · requests carry only accept, user-agent and the API version', async () => {
    const dmg = Buffer.from('fake dmg bytes')
    const feed = await github([{ tag: 'v0.2.1', dmg }])
    const { service } = await harness({ feed: feed.url })
    await service.start()
    await service.check()
    await service.download()
    await waitFor(service, (s) => s.download.phase === 'ready')
    expect(feed.requests.length).toBeGreaterThanOrEqual(4)
    const allowed = new Set([
      'host',
      'connection',
      'accept',
      'user-agent',
      'x-github-api-version',
    ])
    for (const { path, headers } of feed.requests) {
      for (const name of Object.keys(headers))
        expect(allowed, `${path}: ${name}`).toContain(name)
      expect(headers['user-agent']).toBe('Emperor-Agent/0.2.0')
      expect(headers.cookie).toBeUndefined()
      expect(headers.authorization).toBeUndefined()
    }
    expect(
      feed.requests.find((r) => r.path.startsWith(REPO_PATH))?.headers[
        'x-github-api-version'
      ],
    ).toBe('2022-11-28')
    service.close()
  })

  it('not packaged and no test feed: never checks', async () => {
    const calls = { count: 0 }
    const { service, clock } = await harness({
      transport: failingTransport(calls),
      automatic: false,
    })
    await service.start()
    await clock.advance(2 * DAY)
    expect(calls.count).toBe(0)
    expect(service.status()).toMatchObject({ automatic: false })
    await expect(service.check()).rejects.toMatchObject({
      code: 'update_unsupported',
    })
    service.close()
  })
})

describe('REL-02 download', () => {
  it('5 · a verified DMG lands in Downloads, marked as downloaded, shown in Finder', async () => {
    const dmg = Buffer.alloc(256 * 1024, 3)
    const feed = await github([{ tag: 'v0.2.1', dmg }])
    const h = await harness({ feed: feed.url })
    await h.service.start()
    await h.service.check()
    const started = await h.service.download()
    expect(['downloading', 'verifying', 'ready']).toContain(
      started.download.phase,
    )
    const ready = await waitFor(h.service, (s) => s.download.phase === 'ready')
    const path = join(h.downloads, 'Emperor-Agent-0.2.1-macos-arm64.dmg')
    expect(ready.download).toMatchObject({
      phase: 'ready',
      version: '0.2.1',
      path,
      // A test feed has no GitHub attestation to check.
      attestation: { status: 'skipped', reason: 'test_feed' },
    })
    expect((await readFile(path)).equals(dmg)).toBe(true)
    expect(h.revealed).toEqual([path])
    expect(h.quarantined).toEqual([path])
    // Progress was reported on the way.
    expect(
      h.events.some(
        (e) =>
          e.event === 'update_status' &&
          (e.status as UpdateStatus).download.phase === 'downloading',
      ),
    ).toBe(true)
    // Nothing is left in the private staging folder.
    expect(await readdir(h.temp)).toEqual([])
    // 在访达中显示 again.
    await h.service.reveal()
    expect(h.revealed).toEqual([path, path])
    h.service.close()
  })

  it('4 · a SHA-256 that does not match SHA256SUMS.txt is refused and the file deleted', async () => {
    const dmg = Buffer.from('tampered dmg')
    const feed = await github([
      { tag: 'v0.2.1', dmg, claimedDigest: 'f'.repeat(64) },
    ])
    const h = await harness({ feed: feed.url })
    await h.service.start()
    await h.service.check()
    await h.service.download()
    const failed = await waitFor(
      h.service,
      (s) => s.download.phase === 'failed',
    )
    expect(failed.download).toMatchObject({
      phase: 'failed',
      code: 'update_checksum_mismatch',
      message: expect.stringContaining('删除下载的文件'),
    })
    expect(await readdir(h.downloads)).toEqual([])
    expect(await readdir(h.temp)).toEqual([])
    expect(h.revealed).toEqual([])
    await expect(h.service.reveal()).rejects.toMatchObject({
      code: 'update_download_missing',
    })
    h.service.close()
  })

  it('never overwrites a file already in Downloads', async () => {
    const dmg = Buffer.from('new dmg')
    const feed = await github([{ tag: 'v0.2.1', dmg }])
    const h = await harness({ feed: feed.url })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(h.downloads, 'Emperor-Agent-0.2.1-macos-arm64.dmg'),
      'mine',
    )
    await h.service.start()
    await h.service.check()
    await h.service.download()
    const ready = await waitFor(h.service, (s) => s.download.phase === 'ready')
    expect(ready.download).toMatchObject({
      path: join(h.downloads, 'Emperor-Agent-0.2.1-macos-arm64 (1).dmg'),
    })
    expect(
      await readFile(
        join(h.downloads, 'Emperor-Agent-0.2.1-macos-arm64.dmg'),
        'utf8',
      ),
    ).toBe('mine')
    h.service.close()
  })

  it('cancelling stops the download and removes what was written', async () => {
    const calls: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const json = JSON.stringify([
      {
        tag_name: 'v0.2.1',
        name: 'v0.2.1',
        draft: false,
        prerelease: false,
        html_url:
          'https://github.com/TheSyart/emperor-agent/releases/tag/v0.2.1',
        body: '',
        assets: ['Emperor-Agent-0.2.1-macos-arm64.dmg', 'SHA256SUMS.txt'].map(
          (name) => ({
            name,
            size: 10,
            browser_download_url: `https://github.com/TheSyart/emperor-agent/releases/download/v0.2.1/${name}`,
          }),
        ),
      },
    ])
    const h = await harness({
      transport: async (request) => {
        calls.push(request.url.pathname)
        const path = request.url.pathname
        const chunks = path.endsWith('releases')
          ? [Buffer.from(json)]
          : path.endsWith('SHA256SUMS.txt')
            ? [
                Buffer.from(
                  `${'a'.repeat(64)}  Emperor-Agent-0.2.1-macos-arm64.dmg\n`,
                ),
              ]
            : [Buffer.from('12345')]
        return {
          statusCode: 200,
          headers: {},
          body: (async function* () {
            for (const chunk of chunks) yield chunk
            if (path.endsWith('.dmg')) {
              await gate
              if (request.signal.aborted) throw new Error('aborted')
              yield Buffer.from('67890')
            }
          })(),
          close: () => {},
        }
      },
    })
    await h.service.start()
    await h.service.check()
    await h.service.download()
    await waitFor(
      h.service,
      (s) => s.download.phase === 'downloading' && s.download.receivedBytes > 0,
    )
    const cancelled = await h.service.cancelDownload()
    release()
    expect(cancelled.download.phase).toBe('idle')
    await new Promise((r) => setTimeout(r, 50))
    expect(h.service.status().download.phase).toBe('idle')
    expect(await readdir(h.temp)).toEqual([])
    expect(await readdir(h.downloads)).toEqual([])
    h.service.close()
  })

  it('checks the GitHub attestation when gh can; a failed one is refused and deleted', async () => {
    const dmg = Buffer.from('dmg')
    const json = (tag: string) =>
      JSON.stringify([
        {
          tag_name: tag,
          name: tag,
          draft: false,
          prerelease: false,
          html_url: `https://github.com/TheSyart/emperor-agent/releases/tag/${tag}`,
          body: '',
          assets: [
            `Emperor-Agent-${tag.slice(1)}-macos-arm64.dmg`,
            'SHA256SUMS.txt',
          ].map((name) => ({
            name,
            size: name.endsWith('.dmg') ? dmg.byteLength : 100,
            browser_download_url: `https://github.com/TheSyart/emperor-agent/releases/download/${tag}/${name}`,
          })),
        },
      ])
    const transport =
      (tag: string): UpdateTransport =>
      async (request) => {
        const path = request.url.pathname
        const body = path.endsWith('releases')
          ? json(tag)
          : path.endsWith('SHA256SUMS.txt')
            ? `${sha256(dmg)}  Emperor-Agent-${tag.slice(1)}-macos-arm64.dmg\n`
            : dmg
        return {
          statusCode: 200,
          headers: {},
          body: (async function* () {
            yield Buffer.from(body)
          })(),
          close: () => {},
        }
      }
    const attested: string[] = []
    const verified = await harness({
      transport: transport('v0.2.1'),
      attestation: async (file) => {
        attested.push(file)
        return { status: 'verified' }
      },
    })
    await verified.service.start()
    await verified.service.check()
    await verified.service.download()
    expect(
      (await waitFor(verified.service, (s) => s.download.phase === 'ready'))
        .download,
    ).toMatchObject({ attestation: { status: 'verified' } })
    expect(attested).toHaveLength(1)
    verified.service.close()

    const noGh = await harness({
      transport: transport('v0.2.1'),
      attestation: async () => ({
        status: 'unavailable',
        reason: 'gh_missing',
      }),
    })
    await noGh.service.start()
    await noGh.service.check()
    await noGh.service.download()
    expect(
      (await waitFor(noGh.service, (s) => s.download.phase === 'ready'))
        .download,
    ).toMatchObject({
      attestation: { status: 'unavailable', reason: 'gh_missing' },
    })
    noGh.service.close()

    const forged = await harness({
      transport: transport('v0.2.1'),
      attestation: async () => ({
        status: 'failed',
        detail: 'no attestations found',
      }),
    })
    await forged.service.start()
    await forged.service.check()
    await forged.service.download()
    expect(
      (await waitFor(forged.service, (s) => s.download.phase === 'failed'))
        .download,
    ).toMatchObject({ code: 'update_attestation_failed' })
    expect(await readdir(forged.downloads)).toEqual([])
    expect(await readdir(forged.temp)).toEqual([])
    forged.service.close()
  })

  it('a ready download is kept as is while the same version is still offered', async () => {
    const feed = await github([{ tag: 'v0.2.1' }])
    const h = await harness({ feed: feed.url })
    await h.service.start()
    await h.service.check()
    await h.service.download()
    await waitFor(h.service, (s) => s.download.phase === 'ready')
    await h.service.check()
    expect(h.service.status().download.phase).toBe('ready')
    const file = (h.service.status().download as { path: string }).path
    expect((await stat(file)).isFile()).toBe(true)
    h.service.close()
  })
})

describe('REL-02 a newer release after a download', () => {
  it('offers the newer one; the verified file stays in Downloads', async () => {
    const feed = await github([{ tag: 'v0.2.1' }])
    const h = await harness({ feed: feed.url })
    await h.service.start()
    await h.service.check()
    await h.service.download()
    const ready = await waitFor(h.service, (s) => s.download.phase === 'ready')
    const file = (ready.download as { path: string }).path
    feed.releases = [{ tag: 'v0.2.2' }, { tag: 'v0.2.1' }]
    const next = await h.service.check()
    expect(next.available?.version).toBe('0.2.2')
    expect(next.download).toEqual({ phase: 'idle' })
    expect((await stat(file)).isFile()).toBe(true)
    h.service.close()
  })
})

describe('REL-02 diagnostics', () => {
  it('reports the switch, the test feed and an Electron more than 2 majors behind', async () => {
    const feed = await github([
      { tag: 'v0.3.0', body: '<!-- emperor-release electron=45.0.1 -->' },
    ])
    const h = await harness({ feed: feed.url })
    await h.service.start()
    expect(h.service.diagnostics()).toMatchObject({
      enabled: true,
      feedOverride: feed.url,
      electron: { current: '42.2.0', latest: null, outdated: false },
    })
    await h.service.check()
    expect(h.service.diagnostics().electron).toEqual({
      current: '42.2.0',
      latest: '45.0.1',
      behind: 3,
      outdated: true,
    })
    feed.releases = [
      { tag: 'v0.3.0', body: '<!-- emperor-release electron=44.0.0 -->' },
    ]
    await h.service.check()
    expect(h.service.diagnostics().electron).toMatchObject({
      behind: 2,
      outdated: false,
    })
    h.service.close()
  })
})
