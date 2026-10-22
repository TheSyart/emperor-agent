/**
 * AGT-13: the newest Claude Code and Codex releases, from the npm
 * registry's public metadata (a fake registry on 127.0.0.1 here), cached in
 * `<delegations>/executor-versions.json`; and the version 升级 installs:
 * Claude the latest at or above Emperor's minimum, Codex the highest
 * release whose major.minor Emperor verified (the protocol list is
 * injected; newer releases are reported, never offered).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeUpdateTransport } from '../../updates/http'
import type { CodexProtocol } from './compatibility'
import {
  NPM_REGISTRY_URL,
  PublishedVersionStore,
  claudeUpgradeTarget,
  codexUpgradeTarget,
  registryFetcher,
  registryOverrideUrl,
} from './published-versions'
import { delegationTestDirectory } from './testing'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})
function dir() {
  const d = delegationTestDirectory()
  cleanup.push(d.cleanup)
  return d.root
}

const CODEX_VERSIONS = [
  '0.153.0',
  '0.153.4',
  '0.153.4-darwin-arm64',
  '0.160.0',
  '0.163.0-alpha.1',
  '0.163.0',
  '0.163.0-darwin-arm64',
  '0.164.0-alpha.11',
]

interface Registry {
  url: string
  requests: Array<{ path: string; accept: string; headers: string[] }>
  server: Server
}
async function registry(
  options: { codexLatest?: string; status?: number } = {},
): Promise<Registry> {
  const requests: Registry['requests'] = []
  const server = createServer((req, res) => {
    requests.push({
      path: req.url ?? '',
      accept: String(req.headers.accept ?? ''),
      headers: Object.keys(req.headers),
    })
    if (options.status) {
      res.writeHead(options.status)
      return res.end()
    }
    if (req.url === '/@anthropic-ai/claude-code/latest') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          name: '@anthropic-ai/claude-code',
          version: '2.1.308',
        }),
      )
    }
    if (req.url === '/@openai/codex') {
      res.writeHead(200, {
        'content-type': 'application/vnd.npm.install-v1+json',
      })
      return res.end(
        JSON.stringify({
          name: '@openai/codex',
          'dist-tags': {
            latest: options.codexLatest ?? '0.163.0',
            alpha: '0.164.0-alpha.11',
          },
          versions: Object.fromEntries(
            CODEX_VERSIONS.map((v) => [
              v,
              { name: '@openai/codex', version: v },
            ]),
          ),
        }),
      )
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  )
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/`, requests, server }
}

function store(root: string, url: string, now = () => 1_000_000) {
  return new PublishedVersionStore({
    root,
    fetch: registryFetcher({
      transport: nodeUpdateTransport,
      registry: new URL(url),
      userAgent: 'Emperor-Agent/test',
    }),
    now,
  })
}

describe('published versions', () => {
  it('reads Claude’s latest and Codex’s releases from the registry, anonymously', async () => {
    const r = await registry()
    const root = dir()
    const versions = store(root, r.url)
    expect(versions.read()).toEqual({
      checkedAt: null,
      error: null,
      packages: {},
    })
    const snapshot = await versions.check()
    expect(snapshot.error).toBeNull()
    expect(snapshot.checkedAt).toBe(1_000_000)
    expect(snapshot.packages['@anthropic-ai/claude-code']).toEqual({
      latest: '2.1.308',
      versions: ['2.1.308'],
    })
    // Releases only: no alphas, no platform builds; oldest first.
    expect(snapshot.packages['@openai/codex']).toEqual({
      latest: '0.163.0',
      versions: ['0.153.0', '0.153.4', '0.160.0', '0.163.0'],
    })
    expect(r.requests.map((q) => q.path).sort()).toEqual([
      '/@anthropic-ai/claude-code/latest',
      '/@openai/codex',
    ])
    // The abbreviated metadata, and nothing that names the user.
    expect(
      r.requests.find((q) => q.path === '/@openai/codex')?.accept,
    ).toContain('application/vnd.npm.install-v1+json')
    for (const q of r.requests) {
      expect(q.headers).not.toContain('authorization')
      expect(q.headers).not.toContain('cookie')
    }
  })

  it('caches the result on disk; a new store reads it without the network', async () => {
    const r = await registry()
    const root = dir()
    await store(root, r.url).check()
    expect(existsSync(join(root, 'executor-versions.json'))).toBe(true)
    const file = JSON.parse(
      readFileSync(join(root, 'executor-versions.json'), 'utf8'),
    )
    expect(file.schemaVersion).toBe(1)
    const again = store(root, r.url)
    expect(again.read().packages['@openai/codex']?.latest).toBe('0.163.0')
    expect(again.read().checkedAt).toBe(1_000_000)
    expect(r.requests).toHaveLength(2)
    // `due`: older than the given age.
    expect(again.due(60_000, 1_000_000 + 59_000)).toBe(false)
    expect(again.due(60_000, 1_000_000 + 61_000)).toBe(true)
  })

  it('offline: no crash, the versions stay unknown (or what was cached)', async () => {
    const r = await registry()
    const port = new URL(r.url).port
    await new Promise<void>((resolve) => r.server.close(() => resolve()))
    const root = dir()
    const offline = store(root, `http://127.0.0.1:${port}/`)
    const snapshot = await offline.check()
    expect(snapshot).toEqual({
      checkedAt: null,
      error: 'offline',
      packages: {},
    })

    // A cache from before stays; the failed check says so.
    const online = await registry()
    const cached = dir()
    await store(cached, online.url).check()
    const later = store(cached, `http://127.0.0.1:${port}/`, () => 2_000_000)
    const after = await later.check()
    expect(after.error).toBe('offline')
    expect(after.checkedAt).toBe(1_000_000)
    expect(after.packages['@openai/codex']?.latest).toBe('0.163.0')
  })

  it('a registry error is not offline', async () => {
    const r = await registry({ status: 503 })
    const snapshot = await store(dir(), r.url).check()
    expect(snapshot.error).toBe('registry')
    expect(snapshot.packages).toEqual({})
  })

  it('a damaged cache file is ignored', async () => {
    const root = dir()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(root, 'executor-versions.json'), '{not json')
    const r = await registry()
    const versions = store(root, r.url)
    expect(versions.read().checkedAt).toBeNull()
    expect((await versions.check()).error).toBeNull()
  })

  it('only npm’s registry, or a test registry on this Mac', () => {
    expect(NPM_REGISTRY_URL).toBe('https://registry.npmjs.org/')
    expect(registryOverrideUrl(undefined)).toBeNull()
    expect(registryOverrideUrl('http://127.0.0.1:4873')?.href).toBe(
      'http://127.0.0.1:4873/',
    )
    expect(registryOverrideUrl('http://localhost:4873/npm/')?.href).toBe(
      'http://localhost:4873/npm/',
    )
    for (const bad of [
      'https://registry.example.com/',
      'http://user:pw@127.0.0.1:4873/',
      'file:///tmp/registry',
      'not a url',
    ])
      expect(() => registryOverrideUrl(bad)).toThrow()
  })

  it('refuses a redirect off the registry', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'https://evil.example/@openai/codex' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const snapshot = await store(dir(), `http://127.0.0.1:${port}/`).check()
    expect(snapshot.error).toBe('registry')
  })
})

const protocols = (...versions: string[]): CodexProtocol[] =>
  versions.map((version) => ({ version, files: [], digests: [] }))

describe('upgrade targets', () => {
  it('Claude Code: the latest release, when it is newer and at least the minimum', () => {
    expect(claudeUpgradeTarget('2.1.281', '2.1.308')).toBe('2.1.308')
    expect(claudeUpgradeTarget('2.1.308', '2.1.308')).toBeNull()
    expect(claudeUpgradeTarget('2.1.400', '2.1.308')).toBeNull()
    // Too old for Emperor: never offered.
    expect(claudeUpgradeTarget('2.1.20', '2.1.50')).toBeNull()
    // An old, refused claude upgrades to the latest.
    expect(claudeUpgradeTarget('2.1.20', '2.1.308')).toBe('2.1.308')
    expect(claudeUpgradeTarget(null, '2.1.308')).toBe('2.1.308')
    expect(claudeUpgradeTarget('2.1.281', null)).toBeNull()
  })

  const published = {
    latest: '0.163.0',
    versions: ['0.153.0', '0.153.2', '0.153.4', '0.160.0', '0.163.0'],
  }

  it('Codex: the highest release of a verified major.minor; newer ones are 尚未验证', () => {
    expect(
      codexUpgradeTarget('0.153.4', published, protocols('0.153.4')),
    ).toEqual({ target: null, unverified: '0.163.0', verified: ['0.153'] })
    expect(
      codexUpgradeTarget('0.153.2', published, protocols('0.153.4')),
    ).toEqual({ target: '0.153.4', unverified: '0.163.0', verified: ['0.153'] })
    // Once Emperor verifies 0.163, the UI offers it by itself.
    expect(
      codexUpgradeTarget('0.153.4', published, protocols('0.153.4', '0.163.0')),
    ).toEqual({
      target: '0.163.0',
      unverified: null,
      verified: ['0.153', '0.163'],
    })
  })

  it('Codex: never a downgrade, never a prerelease, nothing without the list', () => {
    expect(
      codexUpgradeTarget('0.163.0', published, protocols('0.153.4')),
    ).toEqual({ target: null, unverified: null, verified: ['0.153'] })
    expect(
      codexUpgradeTarget(
        '0.153.4',
        {
          latest: '0.164.0-alpha.11',
          versions: ['0.153.4', '0.164.0-alpha.11'],
        },
        protocols('0.153.4', '0.164.0'),
      ),
    ).toEqual({ target: null, unverified: null, verified: ['0.153', '0.164'] })
    expect(codexUpgradeTarget('0.153.4', null, protocols('0.153.4'))).toEqual({
      target: null,
      unverified: null,
      verified: ['0.153'],
    })
    // Not installed: the highest verified release is what to install.
    expect(codexUpgradeTarget(null, published, protocols('0.153.4'))).toEqual({
      target: '0.153.4',
      unverified: '0.163.0',
      verified: ['0.153'],
    })
  })
})
