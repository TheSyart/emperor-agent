/**
 * Chrome/Edge 智能体权限 (PLAN-CAP-001 RV-09): where the Agent may browse
 * and download in the user's own Chrome or Edge, plus the 浏览器权限 of the
 * same page — 历史记录 (RV-10) and 站点工具 (RV-11).
 *
 * Stored in `<stateRoot>/computer-use/external-site-rules.json` (0600,
 * directory 0700, atomic replace), never in config.json: config.json is
 * parsed strictly, so an older Emperor sharing `~/.emperor` would set the
 * whole config aside over a field it does not know. This file is read
 * leniently instead: unknown fields are ignored and a bad entry falls back
 * to its default; only unreadable JSON is set aside (quarantined).
 *
 * The user's defaults: 浏览 允许, 下载 需要批准. An exception names a host
 * (`example.com`), a host with its subdomains (`*.example.com`) or an exact
 * origin (`https://example.com:8443`); the most specific one wins (origin,
 * then host, then the longest wildcard). Each says allow / ask / block for
 * browsing and for downloads.
 */

import { join } from 'node:path'
import { ValidationError } from '../../errors'
import { AtomicSnapshotSync, type SnapshotCodec } from '../../store/persistence'
import { UiError } from './errors'
import { normalizeOrigin } from './grants/match'

export const EXTERNAL_SITE_DECISIONS = ['allow', 'ask', 'block'] as const
export type ExternalSiteDecision = (typeof EXTERNAL_SITE_DECISIONS)[number]

/** 历史记录: 始终询问 (default) / 始终允许 / 从不. */
export const EXTERNAL_HISTORY_ACCESS = ['ask', 'allow', 'never'] as const
export type ExternalHistoryAccess = (typeof EXTERNAL_HISTORY_ACCESS)[number]

export type ExternalSiteKind = 'browse' | 'download'

export interface ExternalSiteRule {
  /** `example.com`, `*.example.com` or `https://example.com[:port]`. */
  readonly pattern: string
  readonly browse: ExternalSiteDecision
  readonly download: ExternalSiteDecision
}

export interface ExternalBrowserSettings {
  /** The 默认 row of the 智能体权限 table. */
  readonly defaults: {
    readonly browse: ExternalSiteDecision
    readonly download: ExternalSiteDecision
  }
  /** The exceptions, in the order the user added them. */
  readonly sites: readonly ExternalSiteRule[]
  readonly history: ExternalHistoryAccess
  /** 启用站点工具 (WebMCP); see RV-11 for whether it can be used. */
  readonly siteTools: boolean
}

/** A change: `sites` replaces the whole list; anything left out stays. */
export interface ExternalBrowserSettingsPatch {
  readonly defaults?: Partial<ExternalBrowserSettings['defaults']>
  readonly sites?: readonly ExternalSiteRule[]
  readonly history?: ExternalHistoryAccess
  readonly siteTools?: boolean
}

export const DEFAULT_EXTERNAL_BROWSER_SETTINGS: ExternalBrowserSettings =
  Object.freeze({
    defaults: Object.freeze({ browse: 'allow', download: 'ask' } as const),
    sites: Object.freeze([]) as readonly ExternalSiteRule[],
    history: 'ask',
    siteTools: false,
  })

export const EXTERNAL_SITE_RULES_FILE = 'external-site-rules.json'
export const MAX_EXTERNAL_SITE_RULES = 200

const RANK: Readonly<Record<ExternalSiteDecision, number>> = {
  allow: 0,
  ask: 1,
  block: 2,
}
const HISTORY_RANK: Readonly<Record<ExternalHistoryAccess, number>> = {
  never: 0,
  ask: 1,
  allow: 2,
}

/** The stricter of two decisions (block > ask > allow). */
export function stricterDecision(
  a: ExternalSiteDecision,
  b: ExternalSiteDecision,
): ExternalSiteDecision {
  return RANK[a] >= RANK[b] ? a : b
}

function isDecision(value: unknown): value is ExternalSiteDecision {
  return (EXTERNAL_SITE_DECISIONS as readonly unknown[]).includes(value)
}

function isHistoryAccess(value: unknown): value is ExternalHistoryAccess {
  return (EXTERNAL_HISTORY_ACCESS as readonly unknown[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A bare host as URL parsing sees it (lowercase, punycode, no trailing dot). */
function bareHost(raw: string): string | null {
  if (raw.includes('*')) return null
  let url: URL
  try {
    url = new URL(`http://${raw}/`)
  } catch {
    return null
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    return null
  const host = url.hostname.replace(/\.$/, '')
  return host === '' || host.length > 253 ? null : host
}

function isIpHost(host: string): boolean {
  return host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)
}

/**
 * The canonical form of what the user typed, or null when it is not a
 * host, `*.host` or an http(s) origin. A full address keeps only its
 * origin (rules are per site, never per page).
 */
export function normalizeSitePattern(input: string): string | null {
  const raw = input.trim().toLowerCase()
  if (raw === '' || raw.length > 300) return null
  if (raw.includes('://')) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    const host = url.hostname.replace(/\.$/, '')
    if (host === '' || host.includes('*')) return null
    return `${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}`
  }
  if (raw.startsWith('*.')) {
    const host = bareHost(raw.slice(2))
    return host === null || isIpHost(host) ? null : `*.${host}`
  }
  return bareHost(raw)
}

/** Origin and host of an http(s) address; null for anything else. */
function webAddress(url: string): { origin: string; host: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.replace(/\.$/, '')
  if (host === '') return null
  return {
    origin: `${parsed.protocol}//${host}${parsed.port === '' ? '' : `:${parsed.port}`}`,
    host,
  }
}

/** The most specific exception covering `url`, if any. */
export function externalSiteRule(
  settings: ExternalBrowserSettings,
  url: string,
): ExternalSiteRule | undefined {
  const address = webAddress(url)
  if (address === null) return undefined
  let best: { rule: ExternalSiteRule; rank: number } | undefined
  for (const rule of settings.sites) {
    const pattern = rule.pattern
    let rank = 0
    if (pattern.includes('://')) {
      if (pattern === address.origin) rank = 3_000
    } else if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      if (address.host === suffix || address.host.endsWith(`.${suffix}`))
        rank = 1_000 + suffix.length
    } else if (pattern === address.host) rank = 2_000
    if (rank > 0 && (best === undefined || rank > best.rank))
      best = { rule, rank }
  }
  return best?.rule
}

/** What the rules say for `url`; anything but http(s) is blocked. */
export function externalSiteDecision(
  settings: ExternalBrowserSettings,
  url: string,
  kind: ExternalSiteKind,
): ExternalSiteDecision {
  if (webAddress(url) === null) return 'block'
  return externalSiteRule(settings, url)?.[kind] ?? settings.defaults[kind]
}

/** The refusal for a site the user blocked for Emperor (gate and kernel). */
export function externalSiteError(url: string): UiError {
  const origin = normalizeOrigin(url) ?? url.slice(0, 200)
  return new UiError(
    'PERMISSION_DENIED',
    `the user blocked ${origin} for Emperor in Chrome and Edge`,
    {
      reason: 'site-blocked',
      hint: 'Do not try this site another way; tell the user it is blocked in Settings › 电脑操作 › Chrome 和 Edge › 智能体权限.',
    },
  )
}

/** Addresses that stand for every pattern of `list` (for `widens…`). */
function probes(...list: ExternalBrowserSettings[]): string[] {
  const urls = new Set<string>()
  for (const settings of list)
    for (const { pattern } of settings.sites) {
      if (pattern.includes('://')) urls.add(`${pattern}/`)
      else {
        const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern
        urls.add(`https://${host}/`)
        urls.add(`http://${host}/`)
        if (pattern.startsWith('*.')) urls.add(`https://emperor-probe.${host}/`)
      }
    }
  return [...urls]
}

/**
 * Whether `after` lets the Agent do anything `before` did not: a looser
 * default, a looser decision for any site either version names, history
 * without asking, or site tools switched on. Only such changes are guarded
 * (narrowing must work while a card or plan mode is pending).
 */
export function widensExternalBrowserSettings(
  before: ExternalBrowserSettings,
  after: ExternalBrowserSettings,
): boolean {
  const looser = (a: ExternalSiteDecision, b: ExternalSiteDecision) =>
    RANK[b] < RANK[a]
  if (looser(before.defaults.browse, after.defaults.browse)) return true
  if (looser(before.defaults.download, after.defaults.download)) return true
  if (HISTORY_RANK[after.history] > HISTORY_RANK[before.history]) return true
  if (after.siteTools && !before.siteTools) return true
  for (const url of probes(before, after))
    for (const kind of ['browse', 'download'] as const)
      if (
        looser(
          externalSiteDecision(before, url, kind),
          externalSiteDecision(after, url, kind),
        )
      )
        return true
  return false
}

const PATTERN_HINT =
  '请填写网站（example.com）、网站及其子域名（*.example.com）或完整地址（https://example.com）'

/**
 * Apply a change from Settings. Patterns are normalized; a pattern given
 * twice keeps its last values. Throws a {@link ValidationError} the user can
 * read when a pattern is not valid or there are too many exceptions.
 */
export function applyExternalBrowserSettingsPatch(
  current: ExternalBrowserSettings,
  patch: ExternalBrowserSettingsPatch,
): ExternalBrowserSettings {
  const defaults = { ...current.defaults }
  for (const kind of ['browse', 'download'] as const) {
    const value = patch.defaults?.[kind]
    if (value === undefined) continue
    if (!isDecision(value))
      throw new ValidationError(`「${String(value)}」不是有效的权限`)
    defaults[kind] = value
  }
  let sites = current.sites
  if (patch.sites !== undefined) {
    const byPattern = new Map<string, ExternalSiteRule>()
    for (const rule of patch.sites) {
      const pattern = normalizeSitePattern(String(rule.pattern ?? ''))
      if (pattern === null)
        throw new ValidationError(
          `「${String(rule.pattern ?? '')
            .trim()
            .slice(0, 80)}」不是有效的网站或模式：${PATTERN_HINT}`,
        )
      if (!isDecision(rule.browse) || !isDecision(rule.download))
        throw new ValidationError(`「${pattern}」的权限无效`)
      byPattern.delete(pattern)
      byPattern.set(pattern, {
        pattern,
        browse: rule.browse,
        download: rule.download,
      })
    }
    if (byPattern.size > MAX_EXTERNAL_SITE_RULES)
      throw new ValidationError(
        `最多 ${MAX_EXTERNAL_SITE_RULES} 条例外，请先删除一些`,
      )
    sites = [...byPattern.values()]
  }
  if (patch.history !== undefined && !isHistoryAccess(patch.history))
    throw new ValidationError(
      `「${String(patch.history)}」不是有效的历史记录设置`,
    )
  return {
    defaults,
    sites,
    history: patch.history ?? current.history,
    siteTools: patch.siteTools ?? current.siteTools,
  }
}

/** Read a stored document field by field; a bad field keeps its default. */
function decodeLenient(input: unknown): ExternalBrowserSettings {
  if (!isRecord(input) || typeof input.schemaVersion !== 'number')
    throw new Error('not an external browser settings document')
  const base = DEFAULT_EXTERNAL_BROWSER_SETTINGS
  const defaults = isRecord(input.defaults) ? input.defaults : {}
  const sites = new Map<string, ExternalSiteRule>()
  for (const raw of Array.isArray(input.sites) ? input.sites : []) {
    if (!isRecord(raw) || typeof raw.pattern !== 'string') continue
    const pattern = normalizeSitePattern(raw.pattern)
    if (
      pattern === null ||
      !isDecision(raw.browse) ||
      !isDecision(raw.download)
    )
      continue
    sites.delete(pattern)
    sites.set(pattern, { pattern, browse: raw.browse, download: raw.download })
    if (sites.size >= MAX_EXTERNAL_SITE_RULES) break
  }
  return {
    defaults: {
      browse: isDecision(defaults.browse)
        ? defaults.browse
        : base.defaults.browse,
      download: isDecision(defaults.download)
        ? defaults.download
        : base.defaults.download,
    },
    sites: [...sites.values()],
    history: isHistoryAccess(input.history) ? input.history : base.history,
    siteTools:
      typeof input.siteTools === 'boolean' ? input.siteTools : base.siteTools,
  }
}

const CODEC: SnapshotCodec<ExternalBrowserSettings> = {
  schemaVersion: 1,
  encode: (value) => ({
    schemaVersion: 1,
    defaults: value.defaults,
    sites: value.sites,
    history: value.history,
    siteTools: value.siteTools,
  }),
  decode: (input) => ({ value: decodeLenient(input), schemaVersion: 1 }),
}

/** The settings file; only the user changes it (Settings › CoreApi). */
export class ExternalSiteRuleStore {
  private readonly snapshot: AtomicSnapshotSync<ExternalBrowserSettings>
  private cached: ExternalBrowserSettings | null = null

  /** `root`: `<stateRoot>/computer-use`. */
  constructor(root: string) {
    this.snapshot = new AtomicSnapshotSync({
      path: join(root, EXTERNAL_SITE_RULES_FILE),
      codec: CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
  }

  get(): ExternalBrowserSettings {
    if (this.cached === null)
      this.cached = this.snapshot.read({
        fallback: DEFAULT_EXTERNAL_BROWSER_SETTINGS,
      }).value
    return this.cached
  }

  update(patch: ExternalBrowserSettingsPatch): ExternalBrowserSettings {
    const next = applyExternalBrowserSettingsPatch(this.get(), patch)
    this.snapshot.write(next)
    this.cached = next
    return next
  }

  decide(url: string, kind: ExternalSiteKind): ExternalSiteDecision {
    return externalSiteDecision(this.get(), url, kind)
  }
}
