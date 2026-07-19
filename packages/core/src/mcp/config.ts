import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readJson,
  writeJsonAtomic,
  type ConfigRecoveryInfo,
} from '../store/atomic-json'
import { logger } from '../util/log'
import {
  ConfigResolver,
  defineConfigKey,
  type ConfigCandidate,
  type Resolved,
} from '../config/resolver'

export interface ServerConfig {
  name: string
  transport: 'stdio' | 'sse' | string
  enabled: boolean
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  tool_overrides: Record<string, Record<string, unknown>>
}

export interface MCPConfig {
  servers: Record<string, ServerConfig>
  defaults: Record<string, unknown>
}

export const DEFAULT_MCP_CONFIG = {
  servers: {},
  defaults: {
    read_only: false,
    exclusive: false,
  },
} satisfies Record<string, unknown>

export const MCP_CONFIG_FILE = 'mcp_config.json'

const MCP_CONFIG_KEY = defineConfigKey<Record<string, unknown>>({
  id: 'mcp.config',
  builtin: DEFAULT_MCP_CONFIG,
  secretPaths: [
    'servers.*.args',
    'servers.*.env',
    'servers.*.headers',
    'servers.*.url',
  ],
  merge: (current, next) =>
    deepMerge(structuredClone(current), structuredClone(next.value)),
  restrictUntrustedProject: (current, next) =>
    restrictUntrustedMcpConfig(current, next.value),
})

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
export type EnvironmentValueSource =
  Record<string, string | undefined> | ((name: string) => string | undefined)

export async function loadMcpConfig(
  root: string,
  env: EnvironmentValueSource = process.env,
): Promise<MCPConfig> {
  return (await resolveMcpConfig(root, env)).config
}

export interface ResolvedMcpConfig {
  config: MCPConfig
  resolution: Resolved<Record<string, unknown>>
}

/** Legacy `mcp_config.json` remains the writable fact source; this adapter adds
 * deterministic layer provenance without changing the persisted schema. */
export async function resolveMcpConfig(
  root: string,
  env: EnvironmentValueSource = process.env,
  opts: { preserveCorrupt?: boolean } = {},
): Promise<ResolvedMcpConfig> {
  const path = join(root, MCP_CONFIG_FILE)
  const candidates: ConfigCandidate<Record<string, unknown>>[] = []
  if (existsSync(path)) {
    const loaded =
      opts.preserveCorrupt === false
        ? await readMcpConfigWithoutRecovery(path)
        : await readJson<Record<string, unknown>>(
            path,
            structuredClone(DEFAULT_MCP_CONFIG),
            {
              validate: validateRawConfig,
              onCorrupt: reportMcpConfigRecovery,
            },
          )
    if (loaded && (opts.preserveCorrupt === false || existsSync(path)))
      candidates.push({
        source: {
          kind: 'user',
          id: MCP_CONFIG_FILE,
          trust: 'trusted',
        },
        value: expandEnv(loaded, env) as Record<string, unknown>,
      })
  }
  const resolution = new ConfigResolver().resolve(MCP_CONFIG_KEY, {
    candidates,
  })
  return { config: parseConfig(resolution.value), resolution }
}

async function readMcpConfigWithoutRecovery(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return validateRawConfig(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

/** Renderer/editor view: validates and normalizes config but never resolves env placeholders. */
export async function loadMcpConfigUnresolved(
  root: string,
): Promise<MCPConfig> {
  return await loadMcpConfig(root, {})
}

export async function saveMcpConfig(
  root: string,
  raw: Record<string, unknown>,
): Promise<void> {
  if (
    !raw.servers ||
    typeof raw.servers !== 'object' ||
    Array.isArray(raw.servers)
  )
    throw new Error("mcp_config: 'servers' must be an object")
  const data = { ...raw }
  if (
    !data.defaults ||
    typeof data.defaults !== 'object' ||
    Array.isArray(data.defaults)
  )
    data.defaults = DEFAULT_MCP_CONFIG.defaults
  await writeJsonAtomic(join(root, MCP_CONFIG_FILE), data, { mode: 0o600 })
}

export function expandEnv(
  value: unknown,
  env: EnvironmentValueSource = process.env,
): unknown {
  if (typeof value === 'string') {
    return value.replace(
      ENV_RE,
      (match, name: string) => environmentValue(env, name) ?? match,
    )
  }
  if (Array.isArray(value)) return value.map((item) => expandEnv(item, env))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = expandEnv(v, env)
    return out
  }
  return value
}

function environmentValue(
  env: EnvironmentValueSource,
  name: string,
): string | undefined {
  return typeof env === 'function' ? env(name) : env[name]
}

export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      deepMerge(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      target[key] = value
    }
  }
  return target
}

function restrictUntrustedMcpConfig(
  current: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const next = structuredClone(current) as Record<string, unknown>
  const currentDefaults = objectValue(next.defaults)
  const candidateDefaults = objectValue(candidate.defaults)
  if (candidateDefaults.read_only === true) currentDefaults.read_only = true
  if (candidateDefaults.exclusive === true) currentDefaults.exclusive = true
  next.defaults = currentDefaults

  const currentServers = objectValue(next.servers)
  const candidateServers = objectValue(candidate.servers)
  for (const [name, raw] of Object.entries(candidateServers)) {
    const existing = objectValue(currentServers[name])
    const requested = objectValue(raw)
    if (!Object.keys(existing).length || requested.enabled !== false) continue
    currentServers[name] = { ...existing, enabled: false }
  }
  next.servers = currentServers
  return next
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseConfig(raw: Record<string, unknown>): MCPConfig {
  const serversRaw =
    raw.servers &&
    typeof raw.servers === 'object' &&
    !Array.isArray(raw.servers)
      ? (raw.servers as Record<string, unknown>)
      : {}
  const servers: Record<string, ServerConfig> = {}
  for (const [name, cfg] of Object.entries(serversRaw)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue
    const obj = cfg as Record<string, unknown>
    servers[name] = {
      name,
      transport: stringValue(obj.transport, 'stdio'),
      enabled: obj.enabled === undefined ? true : Boolean(obj.enabled),
      command: nullableString(obj.command),
      args: Array.isArray(obj.args) ? obj.args.map((item) => String(item)) : [],
      env: stringRecord(obj.env),
      url: nullableString(obj.url),
      headers: stringRecord(obj.headers),
      tool_overrides: objectRecord(obj.tool_overrides),
    }
  }
  const defaults =
    raw.defaults &&
    typeof raw.defaults === 'object' &&
    !Array.isArray(raw.defaults)
      ? (raw.defaults as Record<string, unknown>)
      : DEFAULT_MCP_CONFIG.defaults
  return { servers, defaults }
}

function stringValue(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  return text || fallback
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = String(v)
  return out
}

function objectRecord(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v))
      out[k] = v as Record<string, unknown>
  }
  return out
}

function validateRawConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('mcp_config must be an object')
  const raw = value as Record<string, unknown>
  if (
    raw.servers !== undefined &&
    (!raw.servers ||
      typeof raw.servers !== 'object' ||
      Array.isArray(raw.servers))
  )
    throw new Error("mcp_config: 'servers' must be an object")
  if (
    raw.defaults !== undefined &&
    (!raw.defaults ||
      typeof raw.defaults !== 'object' ||
      Array.isArray(raw.defaults))
  )
    throw new Error("mcp_config: 'defaults' must be an object")
  return raw
}

function reportMcpConfigRecovery(info: ConfigRecoveryInfo): void {
  logger.warn('Invalid MCP config isolated; using defaults', {
    path: info.path,
    backupPath: info.backupPath,
    error:
      info.error instanceof Error ? info.error.message : String(info.error),
  })
}
