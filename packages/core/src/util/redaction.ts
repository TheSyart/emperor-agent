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
