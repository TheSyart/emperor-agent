/**
 * Normalize pasted MCP server configuration into Emperor's `mcp_config.json`
 * server shape. Accepts the common client formats:
 *
 * - `{ "mcpServers": { … } }` (Claude Desktop / Claude Code / Cursor / Windsurf)
 * - `{ "servers": { … } }` (VS Code `mcp.json` / Emperor), or `{ "mcp": { "servers": { … } } }`
 * - one server object carrying a `name`
 * - a bare `name → config` map
 *
 * Input may be an object or JSON text (JSONC comments, trailing commas, and
 * a fragment such as `"name": { … }` are repaired with a warning). Nothing
 * here touches disk; merging with the stored config lives in `manage.ts`.
 */

import { jsonrepair } from 'jsonrepair'
import { EmperorError } from '../errors'

export type McpTransport = 'stdio' | 'sse' | 'http'

/** One server as persisted in `mcp_config.json`. */
export interface ServerConfigRaw {
  transport: McpTransport
  enabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  tool_overrides?: Record<string, Record<string, unknown>>
}

export interface McpImportResult {
  servers: Record<string, ServerConfigRaw>
  warnings: string[]
}

export class McpImportError extends EmperorError {
  constructor(message: string) {
    super(message, 'mcp_import_invalid')
  }
}

/** Server names become tool prefixes (`mcp_<server>_<tool>`). */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const SERVER_KEYS = new Set([
  'command',
  'args',
  'url',
  'baseUrl',
  'serverUrl',
  'type',
  'transport',
])
/** Fields understood (mapped or deliberately dropped without a warning). */
const KNOWN_FIELDS = new Set([
  'name',
  'type',
  'transport',
  'command',
  'args',
  'env',
  'url',
  'baseUrl',
  'serverUrl',
  'headers',
  'enabled',
  'disabled',
  'tool_overrides',
])

/** Map a client transport spelling to Emperor's transport, or null if unsupported. */
export function normalizeMcpTransport(value: unknown): McpTransport | null {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  if (text === 'stdio' || text === 'local') return 'stdio'
  if (text === 'sse') return 'sse'
  if (
    text === 'http' ||
    text === 'streamable-http' ||
    text === 'streamablehttp' ||
    text === 'streamable_http' ||
    text === 'remote'
  )
    return 'http'
  return null
}

export function normalizeMcpImport(raw: unknown): McpImportResult {
  const warnings: string[] = []
  const value = typeof raw === 'string' ? parseText(raw, warnings) : raw
  if (!isRecord(value)) throw new McpImportError('MCP 导入内容必须是 JSON 对象')
  const entries = unwrapServers(value, warnings)
  const servers: Record<string, ServerConfigRaw> = {}
  for (const [rawName, config] of entries) {
    const name = normalizeServerName(rawName, warnings)
    if (name === null) continue
    if (!isRecord(config)) {
      warnings.push(`已跳过 "${rawName}"：server 配置必须是对象`)
      continue
    }
    const server = normalizeServer(name, config, warnings)
    if (server === null) continue
    if (Object.hasOwn(servers, name))
      warnings.push(`server "${name}" 重名，后出现的配置覆盖了前一个`)
    servers[name] = server
  }
  if (!Object.keys(servers).length && !warnings.length)
    warnings.push('没有识别到任何 MCP server')
  return { servers, warnings }
}

function parseText(text: string, warnings: string[]): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new McpImportError('MCP 导入内容为空')
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through to tolerant parsing below.
  }
  // Only repair text that already looks like an object or a `"name": {…}` fragment.
  const candidates = trimmed.startsWith('{')
    ? [trimmed]
    : trimmed.startsWith('"')
      ? [`{${trimmed}}`]
      : []
  for (const candidate of candidates) {
    try {
      const repaired = JSON.parse(jsonrepair(candidate)) as unknown
      if (!isRecord(repaired)) continue
      warnings.push(
        '输入不是严格 JSON，已自动修复（注释、尾逗号或缺少外层花括号）',
      )
      return repaired
    } catch {
      // Try the next candidate.
    }
  }
  throw new McpImportError('无法解析 MCP 配置：不是有效的 JSON')
}

function unwrapServers(
  value: Record<string, unknown>,
  warnings: string[],
): Array<[string, unknown]> {
  const container = containerOf(value)
  if (container !== null) {
    const ignored = Object.keys(value).filter(
      (key) => key !== container.key && key !== 'inputs',
    )
    if (ignored.length) warnings.push(`已忽略顶层字段：${ignored.join(', ')}`)
    return Object.entries(container.servers)
  }
  if (looksLikeServer(value)) {
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name) {
      warnings.push('单个 server 配置缺少 name，无法导入；请加上 "name" 字段')
      return []
    }
    return [[name, value]]
  }
  return Object.entries(value)
}

function containerOf(
  value: Record<string, unknown>,
): { key: string; servers: Record<string, unknown> } | null {
  if (isRecord(value.mcpServers))
    return { key: 'mcpServers', servers: value.mcpServers }
  if (isRecord(value.servers) && !looksLikeServer(value.servers))
    return { key: 'servers', servers: value.servers }
  if (isRecord(value.mcp) && isRecord(value.mcp.servers))
    return { key: 'mcp', servers: value.mcp.servers }
  return null
}

function looksLikeServer(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(
    (key) => SERVER_KEYS.has(key) && typeof value[key] !== 'object',
  )
}

function normalizeServerName(raw: string, warnings: string[]): string | null {
  const trimmed = raw.trim()
  if (MCP_SERVER_NAME_RE.test(trimmed)) return trimmed
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
  if (!sanitized || !MCP_SERVER_NAME_RE.test(sanitized)) {
    warnings.push(`已跳过 "${raw}"：server 名称只能包含字母、数字、- 和 _`)
    return null
  }
  warnings.push(`server 名称 "${raw}" 已规范为 "${sanitized}"`)
  return sanitized
}

function normalizeServer(
  name: string,
  config: Record<string, unknown>,
  warnings: string[],
): ServerConfigRaw | null {
  const command = optionalString(config.command)
  const url =
    optionalString(config.url) ??
    optionalString(config.baseUrl) ??
    optionalString(config.serverUrl)
  const declared = config.type ?? config.transport
  let transport: McpTransport | null
  if (declared !== undefined && declared !== null && declared !== '') {
    transport = normalizeMcpTransport(declared)
    if (transport === null) {
      warnings.push(
        `已跳过 "${name}"：不支持的 transport "${String(declared)}"（支持 stdio、sse、http）`,
      )
      return null
    }
  } else {
    transport = command ? 'stdio' : url ? 'http' : null
  }
  if (transport === null) {
    warnings.push(`已跳过 "${name}"：缺少 command 或 url`)
    return null
  }

  const ignored = Object.keys(config).filter((key) => !KNOWN_FIELDS.has(key))
  const server: ServerConfigRaw = {
    transport,
    enabled: config.disabled === true ? false : config.enabled !== false,
  }
  if (transport === 'stdio') {
    if (!command) {
      warnings.push(`已跳过 "${name}"：stdio server 缺少 command`)
      return null
    }
    server.command = command
    const args = stringArray(config.args, name, 'args', warnings)
    if (args.length) server.args = args
    const env = stringRecord(config.env, name, 'env', warnings)
    if (Object.keys(env).length) server.env = env
    if (url) ignored.push('url')
    if (isRecord(config.headers) && Object.keys(config.headers).length)
      ignored.push('headers')
  } else {
    if (!url) {
      warnings.push(`已跳过 "${name}"：${transport} server 缺少 url`)
      return null
    }
    if (!isHttpUrl(url)) {
      warnings.push(`已跳过 "${name}"：url 必须是 http(s) 地址`)
      return null
    }
    server.url = url
    const headers = stringRecord(config.headers, name, 'headers', warnings)
    if (Object.keys(headers).length) server.headers = headers
    if (command) ignored.push('command')
    if (Array.isArray(config.args) && config.args.length) ignored.push('args')
    if (isRecord(config.env) && Object.keys(config.env).length)
      ignored.push('env')
  }
  if (isRecord(config.tool_overrides)) {
    const overrides: Record<string, Record<string, unknown>> = {}
    for (const [tool, value] of Object.entries(config.tool_overrides))
      if (isRecord(value)) overrides[tool] = { ...value }
    if (Object.keys(overrides).length) server.tool_overrides = overrides
  }
  if (ignored.length)
    warnings.push(
      `"${name}" 的字段 ${ignored.join(', ')} 不被 Emperor 支持，已忽略`,
    )
  return server
}

function isHttpUrl(value: string): boolean {
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value))
    return /^(?:https?:\/\/|\$\{)/i.test(value)
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text || undefined
}

function stringArray(
  value: unknown,
  server: string,
  field: string,
  warnings: string[],
): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnings.push(`"${server}" 的 ${field} 不是数组，已忽略`)
    return []
  }
  return value
    .filter((item) => item !== undefined && item !== null)
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
}

function stringRecord(
  value: unknown,
  server: string,
  field: string,
  warnings: string[],
): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) {
    warnings.push(`"${server}" 的 ${field} 不是对象，已忽略`)
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    out[key] = typeof item === 'string' ? item : String(item)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
