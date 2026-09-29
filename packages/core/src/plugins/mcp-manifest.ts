/**
 * The two plugin MCP file formats (plugin contract §1.4). They never borrow
 * from each other: the portable `mcp.json` (agent-plugins schema) requires
 * `$schema` and a transport `type` on every server and rejects unknown
 * fields; the older `.mcp.json` shape infers the transport and ignores
 * unknown fields. Both produce {@link PluginMcpServerSpec} values with
 * variables left unexpanded.
 */

import { PluginPackageError } from './errors'
import { hasControlCharacter, type PluginMcpServerSpec } from './models'

const MCP_SCHEMA =
  /^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/mcp\.schema\.json$/
const SUPPORTED_SCHEMA_VERSION = /^1\.\d+\.\d+$/
const RESERVED_ENV = ['PLUGIN_ROOT', 'PLUGIN_DATA']
const MAX_SERVER_NAME = 128

/** Decode a portable `mcp.json`; `file` names the file in messages. */
export function decodePortableMcp(
  raw: unknown,
  file: string,
): PluginMcpServerSpec[] {
  const root = objectOf(raw)
  if (!root) throw invalid(`${file} 必须是 JSON 对象`)
  const schema = root.$schema
  if (typeof schema !== 'string') throw invalid(`${file} 缺少 $schema`)
  const match = MCP_SCHEMA.exec(schema)
  if (!match)
    throw invalid(`${file} 的 $schema 不是 agent-plugins.org 的 MCP schema`)
  if (!SUPPORTED_SCHEMA_VERSION.test(match[1]!))
    throw new PluginPackageError(
      'schema_unsupported',
      `不支持 ${file} 的 schema 版本 ${match[1]}`,
    )
  for (const key of Object.keys(root))
    if (key !== '$schema' && key !== 'mcpServers')
      throw invalid(`${file} 有不认识的字段「${key}」`)
  const servers = objectOf(root.mcpServers)
  if (!servers) throw invalid(`${file} 缺少 mcpServers 对象`)
  return Object.entries(servers).map(([name, value]) =>
    portableServer(name, value, file),
  )
}

/** Decode an older `.mcp.json`: `{ "mcpServers": {…} }` or a bare server map. */
export function decodeLegacyMcp(
  raw: unknown,
  file: string,
): PluginMcpServerSpec[] {
  const root = objectOf(raw)
  if (!root) throw invalid(`${file} 必须是 JSON 对象`)
  let servers: Record<string, unknown>
  if ('mcpServers' in root) {
    const inner = objectOf(root.mcpServers)
    if (!inner) throw invalid(`${file} 的 mcpServers 必须是对象`)
    servers = inner
  } else {
    servers = Object.fromEntries(
      Object.entries(root).filter(([key]) => key !== '$schema'),
    )
  }
  return Object.entries(servers).map(([name, value]) =>
    legacyServer(name, value, file),
  )
}

function portableServer(
  name: string,
  value: unknown,
  file: string,
): PluginMcpServerSpec {
  checkServerName(name, file)
  const server = objectOf(value)
  if (!server) throw invalid(`${file} 里的 server「${name}」必须是对象`)
  const where = `${file} 里的 server「${name}」`
  if (server.type === 'stdio') {
    onlyKeys(server, ['type', 'command', 'args', 'env', 'cwd'], where)
    const env = stringMap(server.env, `${where}的 env`)
    const reserved = RESERVED_ENV.find((key) => env && key in env)
    if (reserved) throw invalid(`${where}的 env 不能设置 ${reserved}`)
    return stdioSpec(name, server, env, where)
  }
  if (server.type === 'streamable-http' || server.type === 'sse') {
    onlyKeys(server, ['type', 'url', 'headers'], where)
    return remoteSpec(
      name,
      server,
      server.type === 'sse' ? 'sse' : 'http',
      where,
    )
  }
  throw invalid(`${where}的 type 必须是 stdio、streamable-http 或 sse`)
}

function legacyServer(
  name: string,
  value: unknown,
  file: string,
): PluginMcpServerSpec {
  checkServerName(name, file)
  const server = objectOf(value)
  if (!server) throw invalid(`${file} 里的 server「${name}」必须是对象`)
  const where = `${file} 里的 server「${name}」`
  const type = server.type
  if (type !== undefined && typeof type !== 'string')
    throw invalid(`${where}的 type 必须是字符串`)
  let transport: PluginMcpServerSpec['transport']
  switch (type) {
    case undefined:
      if (server.command !== undefined) transport = 'stdio'
      else if (server.url !== undefined) transport = 'http'
      else throw invalid(`${where}缺少 command 或 url`)
      break
    case 'stdio':
      transport = 'stdio'
      break
    case 'http':
    case 'streamable-http':
      transport = 'http'
      break
    case 'sse':
      transport = 'sse'
      break
    default:
      throw invalid(`${where}的 type「${type}」不受支持`)
  }
  if (transport === 'stdio')
    return stdioSpec(
      name,
      server,
      stringMap(server.env, `${where}的 env`),
      where,
    )
  return remoteSpec(name, server, transport, where)
}

function stdioSpec(
  name: string,
  server: Record<string, unknown>,
  env: Record<string, string> | undefined,
  where: string,
): PluginMcpServerSpec {
  const command = server.command
  if (typeof command !== 'string' || !command.trim())
    throw invalid(`${where}缺少 command`)
  const args = stringList(server.args, `${where}的 args`)
  const cwd = server.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || !cwd.trim()))
    throw invalid(`${where}的 cwd 必须是非空字符串`)
  return {
    name,
    transport: 'stdio',
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
  }
}

function remoteSpec(
  name: string,
  server: Record<string, unknown>,
  transport: 'http' | 'sse',
  where: string,
): PluginMcpServerSpec {
  const url = server.url
  if (typeof url !== 'string' || !url.trim()) throw invalid(`${where}缺少 url`)
  const headers = stringMap(server.headers, `${where}的 headers`)
  return { name, transport, url, ...(headers ? { headers } : {}) }
}

function checkServerName(name: string, file: string): void {
  if (
    !name ||
    name !== name.trim() ||
    name.length > MAX_SERVER_NAME ||
    hasControlCharacter(name)
  )
    throw invalid(`${file} 里有不合法的 server 名「${name}」`)
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw invalid(`${where}有不认识的字段「${key}」`)
}

function stringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw invalid(`${where}必须是字符串数组`)
  return [...value]
}

function stringMap(
  value: unknown,
  where: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const map = objectOf(value)
  if (!map || !Object.values(map).every((item) => typeof item === 'string'))
    throw invalid(`${where}必须是字符串到字符串的对象`)
  return { ...(map as Record<string, string>) }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function invalid(message: string): PluginPackageError {
  return new PluginPackageError('member_invalid', message)
}
