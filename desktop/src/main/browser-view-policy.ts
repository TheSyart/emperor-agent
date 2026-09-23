import type { Rectangle } from 'electron'

/** Longest address-bar input (after trimming) and normalized URL accepted. */
export const BROWSER_INPUT_MAX_LENGTH = 2048

export type BrowserInputResult =
  { ok: true; url: string } | { ok: false; reason: string }

export const BROWSER_INPUT_REASONS = {
  empty: '请输入网址',
  tooLong: `网址过长（最多 ${BROWSER_INPUT_MAX_LENGTH} 个字符）`,
  invalid: '无法识别的网址',
  scheme: '只支持 http 和 https 网址',
  credentials: '网址不能包含用户名或密码',
} as const

/**
 * Schemes that are never web pages, rejected even when the input could also
 * read as `host:port`. Anything else that is not http(s) is rejected too; the
 * list only keeps `javascript:1`-style input from being taken for a host.
 */
const BLOCKED_SCHEMES = new Set([
  'about',
  'app',
  'blob',
  'chrome',
  'chrome-extension',
  'chrome-untrusted',
  'data',
  'devtools',
  'file',
  'filesystem',
  'javascript',
  'mailto',
  'tel',
  'vbscript',
  'view-source',
])

const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):/i
/** `localhost:5173`, `example.com:8080/path`: a bare host with a port. */
const BARE_HOST_PORT = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i
/** `user:pass@host`: an `@` before the first path, query or fragment. */
const BARE_USERINFO = /^[^/?#]*@/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Normalize what the user typed into the browser address bar into an http(s)
 * URL. Bare hosts get `http://` when they name this machine and `https://`
 * otherwise; every other scheme, credentials, control characters and
 * unparseable input are rejected.
 */
export function normalizeBrowserInput(text: unknown): BrowserInputResult {
  if (typeof text !== 'string') return reject('invalid')
  const input = text.trim()
  if (!input) return reject('empty')
  if (input.length > BROWSER_INPUT_MAX_LENGTH) return reject('tooLong')
  // The URL parser silently drops tabs and newlines ("java\tscript:"), so
  // control characters are refused before any scheme detection.
  if (CONTROL_CHARACTERS.test(input)) return reject('invalid')
  // Paths and protocol-relative input are not addresses.
  if (/^[/\\]/.test(input)) return reject('invalid')

  const scheme = SCHEME_PREFIX.exec(input)?.[1]?.toLowerCase() ?? ''
  if (BLOCKED_SCHEMES.has(scheme)) return reject('scheme')
  let url: URL | null
  if (scheme === 'http' || scheme === 'https') url = parseUrl(input)
  else if (!scheme || BARE_HOST_PORT.test(input) || BARE_USERINFO.test(input))
    url = withInferredScheme(input)
  else return reject('scheme')

  if (!url || !url.hostname) return reject('invalid')
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return reject('scheme')
  if (url.username || url.password) return reject('credentials')
  if (url.href.length > BROWSER_INPUT_MAX_LENGTH) return reject('tooLong')
  return { ok: true, url: url.href }
}

/**
 * Guard for navigations inside the browser view (`will-navigate`,
 * `will-redirect`): only credential-free http(s) targets may load.
 */
export function browserNavigationAllowed(target: unknown): boolean {
  const url = parseUrl(typeof target === 'string' ? target : '')
  return Boolean(
    url &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname &&
    !url.username &&
    !url.password,
  )
}

/**
 * Popups from the browser view are always denied; a remote http(s) target is
 * handed to the system browser instead. Addresses of this machine are not.
 */
export function browserExternalOpenEligible(target: unknown): boolean {
  if (!browserNavigationAllowed(target)) return false
  const url = parseUrl(target as string)
  return Boolean(url && !isLocalHostname(url.hostname))
}

/**
 * Whether a parsed URL hostname names this machine: `localhost` and
 * `*.localhost`, 127.0.0.0/8, 0.0.0.0, `[::1]`, `[::]` and IPv4-mapped forms.
 * Expects the parser's canonical form (`127.1` is already `127.0.0.1`).
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (/^127(?:\.\d{1,3}){3}$/.test(host) || host === '0.0.0.0') return true
  if (host === '::1' || host === '::') return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (!mapped) return false
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return high >> 8 === 127 || (high === 0 && low === 0)
}

/** Renderer-reported viewport rectangle, or null when it cannot host a page. */
export function normalizedBrowserBounds(value: unknown): Rectangle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(raw[key]))
  if (numbers.some((entry) => !Number.isFinite(entry))) return null
  const [x, y, width, height] = numbers as [number, number, number, number]
  if (width < 120 || height < 80 || width > 10_000 || height > 10_000)
    return null
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

function withInferredScheme(input: string): URL | null {
  const probe = parseUrl(`http://${input}`)
  if (!probe) return null
  if (isLocalHostname(probe.hostname)) return probe
  return parseUrl(`https://${input}`)
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function reject(reason: keyof typeof BROWSER_INPUT_REASONS): {
  ok: false
  reason: string
} {
  return { ok: false, reason: BROWSER_INPUT_REASONS[reason] }
}
