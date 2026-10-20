import { homedir, userInfo } from 'node:os'

export interface SensitiveOutputRedactionOptions {
  readonly home?: string | null
  readonly username?: string | null
}

/** Shared persistence-boundary scrubber for bounded summaries and audit data. */
export function redactSensitiveOutput(
  value: string,
  options: SensitiveOutputRedactionOptions = {},
): string {
  const home =
    options.home === undefined ? homedir() : String(options.home ?? '')
  const username =
    options.username === undefined
      ? safeUsername()
      : String(options.username ?? '')
  let output = String(value ?? '')
  if (home) output = output.replaceAll(home, '[HOME]')
  if (username) output = output.replaceAll(username, '[USER]')
  output = output.replace(
    /\b(proxy-authorization|authorization)\s*:[^\r\n]*/gi,
    '$1: [REDACTED]',
  )
  output = output.replace(
    /\b([A-Za-z0-9-]*(?:api[-_]?key|token|secret|authorization|credential)[A-Za-z0-9-]*)\s*:[^\r\n'";]*/gi,
    '$1: [REDACTED]',
  )
  output = output.replace(
    /\b(set-cookie|cookie)\s*:[^\r\n]*/gi,
    '$1: [REDACTED]',
  )
  output = output.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
  output = output.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  )
  output = output.replace(
    /\b(?:(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    '[REDACTED_TOKEN]',
  )
  output = output.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED_JWT]',
  )
  output = output.replace(
    /\b(token|api[_-]?key|password|secret)=(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;]+)/gi,
    '$1=[REDACTED]',
  )
  output = output.replace(
    /(--(?:api[-_]?key|token|password|secret))(?:=|\s+)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;]+)/gi,
    '$1 [REDACTED]',
  )
  output = output.replace(
    /((?:["']?)(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|AWS_SECRET_ACCESS_KEY|GH_TOKEN|GITHUB_TOKEN|[A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD)|token|api[_-]?key|password|secret)(?:["']?)[ \t]*[:=][ \t]*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;]+)/gi,
    '$1[REDACTED]',
  )
  output = output.replace(/https?:\/\/[^\s"']+/gi, redactUrl)
  output = output.replace(/\b[A-Za-z]:\\(?:[^\\\r\n\t "'<>|]+\\?)+/g, '[PATH]')
  output = output.replace(
    /(?<![A-Za-z0-9:/\\])\/(?:[^/\s"'<>:;|]+\/?)+/g,
    '[PATH]',
  )
  return output
}

export function redactSensitiveValue(
  value: unknown,
  options: SensitiveOutputRedactionOptions = {},
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (depth > 8) return '[TRUNCATED]'
  if (typeof value === 'string') return redactSensitiveOutput(value, options)
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((item) => redactSensitiveValue(item, options, seen, depth + 1))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactSensitiveValue(child, options, seen, depth + 1)
  }
  seen.delete(value)
  return output
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '[REDACTED_URL]'
  }
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|cookie|proxy.*(?:user|pass|auth)/i.test(
    key,
  )
}

function safeUsername(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

/** Query and fragment parameters whose value never reaches a log. */
const SENSITIVE_URL_PARAM =
  /^(?:[A-Za-z0-9_.-]*token|[A-Za-z0-9_.-]*secret|[A-Za-z0-9_.-]*password|key|api[-_]?key|apikey|auth|sig|signature|code|session(?:id)?|pwd|pass|jwt|x-amz-(?:signature|credential|security-token))$/i

const LOG_KEY =
  '(?:x-)?api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|client[-_]?secret|token|secret|password|passwd'

/**
 * What a persistent log line may keep (REL-01): unlike
 * {@link redactSensitiveOutput}, paths and ordinary text stay, so the log
 * remains useful; keys, tokens, credentials in URLs and Authorization or
 * Cookie headers do not. `sk-` keys keep their prefix (`sk-***`), anything
 * else becomes `***`. Applying it twice changes nothing.
 */
export function redactLogText(value: string): string {
  let output = String(value ?? '')
  output = output.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,
    redactUrlTokens,
  )
  output = output.replace(
    /\b(proxy-authorization|authorization)(["']?\s*[:=]\s*["']?)[^"'\r\n,}]*/gi,
    '$1$2***',
  )
  output = output.replace(/\b(set-cookie|cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2***')
  output = output.replace(/\bBearer\s+(?!\*\*\*)[^\s,;"']+/g, 'Bearer ***')
  output = output.replace(
    /(--(?:api[-_]?key|token|password|secret))(=|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;"']+)/gi,
    '$1$2***',
  )
  output = output.replace(
    new RegExp(
      `(?<![A-Za-z0-9])(${LOG_KEY})(["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&#"'}]+)`,
      'gi',
    ),
    (_match, key: string, separator: string, offset: number, all: string) => {
      const quoted = all[offset + key.length + separator.length]
      const mark = quoted === '"' || quoted === "'" ? quoted : ''
      return `${key}${separator}${mark}***${mark}`
    },
  )
  output = output.replace(
    /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))=(?!\*\*\*)[^\s,;"']+/g,
    '$1=***',
  )
  output = output.replace(/\bsk-[A-Za-z0-9_-]{3,}/g, 'sk-***')
  output = output.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    '***',
  )
  return output
}

function redactUrlTokens(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/i, '$1***@')
    .replace(
      /([?&#;])([A-Za-z0-9_.-]+)=([^&#\s]*)/g,
      (match, separator: string, name: string) =>
        SENSITIVE_URL_PARAM.test(name) ? `${separator}${name}=***` : match,
    )
}
