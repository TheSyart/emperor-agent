import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableReplaceSync } from '../../store/persistence'
import type { UpdateTransport } from '../../updates/types'
import {
  claudeVersionSupported,
  formatVersion,
  KNOWN_CODEX_PROTOCOLS,
  parseVersion,
  type CodexProtocol,
  type SemanticVersion,
} from './compatibility'
import { EXECUTOR_PACKAGES } from './install-source'

/**
 * The newest Claude Code and Codex releases (AGT-13), from the npm
 * registry's public metadata: Claude's `/latest`, Codex's abbreviated
 * document (its `latest` and every release, to find the highest one of a
 * verified major.minor). A plain GET without credentials, cookies or
 * anything about the user; only https://registry.npmjs.org, or a test
 * registry on this Mac (EMPEROR_EXECUTOR_REGISTRY_URL). Cached in
 * `<delegations>/executor-versions.json` with the 稍后 choice.
 */

export const NPM_REGISTRY_URL = 'https://registry.npmjs.org/'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 20_000

/** EMPEROR_EXECUTOR_REGISTRY_URL: unset → null; else loopback http(s) only. */
export function registryOverrideUrl(
  value: string | undefined | null,
): URL | null {
  if (!value) return null
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !LOOPBACK.has(url.hostname)
  )
    throw new Error(
      'the executor registry may only be a test registry on this Mac',
    )
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

export interface PublishedPackage {
  /** npm's `latest`. */
  latest: string | null
  /** Releases only (x.y.z), oldest first. */
  versions: string[]
}

export type PublishedFetch = (packageName: string) => Promise<PublishedPackage>

class RegistryError extends Error {
  constructor(readonly kind: 'offline' | 'registry') {
    super(kind)
  }
}

const RELEASE = /^\d+\.\d+\.\d+$/
const compare = (a: SemanticVersion, b: SemanticVersion) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch
const byVersion = (a: string, b: string) =>
  compare(parseVersion(a)!, parseVersion(b)!)

/** Reads one package's versions from a registry through the host's HTTP. */
export function registryFetcher(options: {
  transport: UpdateTransport
  registry: URL
  userAgent: string
}): PublishedFetch {
  const getJson = async (path: string, accept: string): Promise<unknown> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    timer.unref?.()
    try {
      let url = new URL(path, options.registry)
      for (let hop = 0; ; hop++) {
        if (
          url.origin !== options.registry.origin ||
          url.username ||
          url.password
        )
          throw new RegistryError('registry')
        let response
        try {
          response = await options.transport({
            url,
            headers: { accept, 'user-agent': options.userAgent },
            signal: controller.signal,
          })
        } catch {
          throw new RegistryError('offline')
        }
        const status = response.statusCode
        if (status >= 300 && status < 400 && hop < 3) {
          response.close()
          const location = response.headers.location
          const next = Array.isArray(location) ? location[0] : location
          if (!next) throw new RegistryError('registry')
          url = new URL(next, url)
          continue
        }
        if (status !== 200) {
          response.close()
          throw new RegistryError('registry')
        }
        const chunks: Buffer[] = []
        let bytes = 0
        try {
          for await (const chunk of response.body) {
            bytes += chunk.byteLength
            if (bytes > MAX_BYTES) throw new RegistryError('registry')
            chunks.push(Buffer.from(chunk))
          }
        } catch (error) {
          throw error instanceof RegistryError
            ? error
            : new RegistryError('offline')
        } finally {
          response.close()
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          throw new RegistryError('registry')
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return async (packageName) => {
    if (packageName === EXECUTOR_PACKAGES['claude-code']) {
      const body = (await getJson(
        `${packageName}/latest`,
        'application/json',
      )) as {
        version?: unknown
      }
      const latest =
        typeof body?.version === 'string' && RELEASE.test(body.version)
          ? body.version
          : null
      if (!latest) throw new RegistryError('registry')
      return { latest, versions: [latest] }
    }
    const body = (await getJson(
      packageName,
      'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
    )) as { 'dist-tags'?: { latest?: unknown }; versions?: unknown }
    if (!body?.versions || typeof body.versions !== 'object')
      throw new RegistryError('registry')
    const versions = Object.keys(body.versions)
      .filter((v) => RELEASE.test(v))
      .sort(byVersion)
    const tag = body['dist-tags']?.latest
    return {
      latest:
        typeof tag === 'string' && RELEASE.test(tag)
          ? tag
          : (versions.at(-1) ?? null),
      versions,
    }
  }
}

export interface PublishedSnapshot {
  /** The last check that reached the registry. */
  checkedAt: number | null
  /** The last check failed: npm was unreachable, or answered nonsense. */
  error: 'offline' | 'registry' | null
  packages: Record<string, PublishedPackage>
}

interface CacheFile {
  schemaVersion: 1
  checkedAt: number | null
  packages: Record<string, PublishedPackage>
  /** 稍后: the version offered per profile when it was chosen. */
  dismissed?: Record<string, string>
}

export class PublishedVersionStore {
  readonly file: string
  private data: CacheFile = { schemaVersion: 1, checkedAt: null, packages: {} }
  private error: PublishedSnapshot['error'] = null
  private pending: Promise<PublishedSnapshot> | null = null
  private readonly now: () => number
  constructor(
    private readonly options: {
      root: string
      fetch: PublishedFetch
      now?: () => number
    },
  ) {
    this.now = options.now ?? Date.now
    this.file = join(options.root, 'executor-versions.json')
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as CacheFile
        if (
          raw?.schemaVersion === 1 &&
          raw.packages &&
          typeof raw.packages === 'object'
        )
          this.data = {
            schemaVersion: 1,
            checkedAt: typeof raw.checkedAt === 'number' ? raw.checkedAt : null,
            packages: raw.packages,
            ...(raw.dismissed && typeof raw.dismissed === 'object'
              ? { dismissed: raw.dismissed }
              : {}),
          }
      }
    } catch {
      /* A cache: checked again. */
    }
  }
  read(): PublishedSnapshot {
    return {
      checkedAt: this.data.checkedAt,
      error: this.error,
      packages: structuredClone(this.data.packages),
    }
  }
  get checking(): boolean {
    return this.pending !== null
  }
  /** The last check is older than `ageMs` (or there was none). */
  due(ageMs: number, now = this.now()): boolean {
    return this.data.checkedAt === null || now - this.data.checkedAt >= ageMs
  }
  /** Asks the registry for both CLIs; one check at a time. */
  check(): Promise<PublishedSnapshot> {
    this.pending ??= this.run().finally(() => {
      this.pending = null
    })
    return this.pending
  }
  private async run(): Promise<PublishedSnapshot> {
    try {
      const names = Object.values(EXECUTOR_PACKAGES)
      const found = await Promise.all(
        names.map((name) => this.options.fetch(name)),
      )
      this.data.packages = Object.fromEntries(
        names.map((name, i) => [name, found[i]!]),
      )
      this.data.checkedAt = this.now()
      this.error = null
      this.save()
    } catch (error) {
      this.error = error instanceof RegistryError ? error.kind : 'offline'
    }
    return this.read()
  }
  dismissed(): Record<string, string> {
    return { ...(this.data.dismissed ?? {}) }
  }
  dismiss(offered: Record<string, string>): void {
    this.data.dismissed = { ...offered }
    this.save()
  }
  private save() {
    try {
      durableReplaceSync(this.file, JSON.stringify(this.data, null, 2) + '\n')
    } catch {
      /* Kept in memory; checked again next time. */
    }
  }
}

/** Claude Code: npm's latest, when it is newer and Emperor supports it. */
export function claudeUpgradeTarget(
  installed: string | null,
  latest: string | null,
): string | null {
  const next = parseVersion(latest)
  if (!next || !claudeVersionSupported(next)) return null
  const current = parseVersion(installed)
  return !current || compare(next, current) > 0 ? formatVersion(next) : null
}

/**
 * Codex: the highest release whose major.minor Emperor verified (read from
 * the protocol list at run time, so a newly verified one is offered by
 * itself); `unverified`: npm's latest when its line is not verified and it
 * is newer than what is installed or offered.
 */
export function codexUpgradeTarget(
  installed: string | null,
  published: PublishedPackage | null | undefined,
  protocols: readonly CodexProtocol[] = KNOWN_CODEX_PROTOCOLS,
): { target: string | null; unverified: string | null; verified: string[] } {
  const lines = [
    ...new Set(
      protocols.flatMap((p) => {
        const v = parseVersion(p.version)
        return v ? [`${v.major}.${v.minor}`] : []
      }),
    ),
  ].sort((a, b) => byVersion(`${a}.0`, `${b}.0`))
  const current = parseVersion(installed)
  const line = (v: SemanticVersion) => `${v.major}.${v.minor}`
  const releases = (published?.versions ?? [])
    .filter((v) => RELEASE.test(v))
    .map((v) => parseVersion(v)!)
  const best = releases
    .filter((v) => lines.includes(line(v)))
    .sort(compare)
    .at(-1)
  const target =
    best && (!current || compare(best, current) > 0)
      ? formatVersion(best)
      : null
  const latest =
    published?.latest && RELEASE.test(published.latest)
      ? parseVersion(published.latest)!
      : undefined
  const floor = [current, best].filter(Boolean) as SemanticVersion[]
  const unverified =
    latest &&
    !lines.includes(line(latest)) &&
    floor.every((v) => compare(latest, v) > 0)
      ? formatVersion(latest)
      : null
  return { target, unverified, verified: lines }
}
