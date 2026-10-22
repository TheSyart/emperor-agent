import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AtomicSnapshot,
  type PersistenceAdapter,
  type SnapshotCodec,
} from '../store/persistence'
import { EmperorError } from '../errors'
import {
  isSealedSecret,
  SECRET_FIELD_NAME,
  type SecretSealer,
} from '../security/secret-sealer'
import { logger } from '../util/log'
import { normalizeMcpTransport } from './import'
import {
  ConfigResolver,
  defineConfigKey,
  type ConfigCandidate,
  type Resolved,
} from '../config/resolver'

export interface ServerConfig {
  name: string
  /** `stdio` | `sse` | `http` (Streamable HTTP); anything else is a configuration error. */
  transport: 'stdio' | 'sse' | 'http' | string
  enabled: boolean
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  tool_overrides: Record<string, Record<string, unknown>>
  /** Working directory of a stdio server; plugin servers run in their package. Never read from `mcp_config.json`. */
  cwd?: string | null
  /** Folders inside Emperor Home a sandboxed stdio server may use (a plugin's package and data). Never read from `mcp_config.json`. */
  stateGrants?: { read: string[]; write: string[] } | null
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
/** The copy of a file that still held plaintext tokens, made before sealing them (SEC-06). */
export const MCP_CONFIG_PRE_SEAL_PREFIX = `${MCP_CONFIG_FILE}.pre-seal-`

/** What a sealed `headers` / `env` value is bound to: it opens only there. */
export function mcpSecretContext(
  server: string,
  field: 'headers' | 'env',
  name: string,
): string {
  return `${MCP_CONFIG_FILE}#servers/${server}/${field}/${name}`
}

/** A rejected `mcp_config.json` write; the message names paths only, never values. */
export class McpConfigError extends EmperorError {
  constructor(message: string) {
    super(message, 'mcp_config_invalid')
  }
}

export interface McpConfigPersistenceOptions {
  persistenceAdapter?: PersistenceAdapter
  /**
   * SEC-06: seals `headers` / `env` values whose names look secret
   * ({@link SECRET_FIELD_NAME}) on save, and opens sealed values on load.
   */
  sealer?: SecretSealer | null
}

/**
 * What a load does with a sealed value it cannot open: `drop` it (connecting
 * then fails authentication instead of sending ciphertext), or `keep` the
 * sealed text (editor round trips, so a save does not lose it).
 */
export type UnreadableSecrets = 'drop' | 'keep'

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
const ENV_PLACEHOLDER_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/
export const MCP_EDITOR_SECRET_MARKER = '[REDACTED]'
export type EnvironmentValueSource =
  Record<string, string | undefined> | ((name: string) => string | undefined)

export async function loadMcpConfig(
  root: string,
  env: EnvironmentValueSource = process.env,
  opts: McpConfigPersistenceOptions = {},
): Promise<MCPConfig> {
  return (await resolveMcpConfig(root, env, opts)).config
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
  opts: {
    preserveCorrupt?: boolean
    unreadableSecrets?: UnreadableSecrets
  } & McpConfigPersistenceOptions = {},
): Promise<ResolvedMcpConfig> {
  const path = join(root, MCP_CONFIG_FILE)
  const candidates: ConfigCandidate<Record<string, unknown>>[] = []
  if (existsSync(path)) {
    let loaded: Record<string, unknown> | null
    let found = true
    if (opts.preserveCorrupt === false) {
      loaded = await readMcpConfigWithoutRecovery(path)
    } else {
      const snapshot = await mcpConfigSnapshot(
        path,
        opts.persistenceAdapter,
      ).read({ fallback: structuredClone(DEFAULT_MCP_CONFIG) })
      loaded = snapshot.value
      found = snapshot.found
      if (snapshot.receipt.recoveryAction === 'quarantined_corrupt_snapshot')
        reportMcpConfigRecovery({
          path,
          backupPath: snapshot.receipt.corruptionBackup ?? '',
          error: new Error('MCP config failed schema validation'),
        })
    }
    if (
      loaded &&
      (opts.preserveCorrupt === false || (found && existsSync(path)))
    )
      candidates.push({
        source: {
          kind: 'user',
          id: MCP_CONFIG_FILE,
          trust: 'trusted',
        },
        value: expandEnv(
          openMcpSecrets(loaded, opts.sealer, opts.unreadableSecrets ?? 'drop'),
          env,
        ) as Record<string, unknown>,
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
  opts: McpConfigPersistenceOptions = {},
): Promise<MCPConfig> {
  return maskMcpEditorSecrets(
    (await resolveMcpConfig(root, {}, { ...opts, unreadableSecrets: 'keep' }))
      .config,
  )
}

function maskMcpEditorSecrets(config: MCPConfig): MCPConfig {
  const masked = structuredClone(config)
  for (const server of Object.values(masked.servers)) {
    server.args = server.args.map(maskSecretLeaf)
    server.env = maskSecretRecord(server.env)
    server.headers = maskSecretRecord(server.headers)
    server.url = server.url === null ? null : maskSecretUrl(server.url)
  }
  return masked
}

/** The stored `mcp_config.json` as written: no env expansion, no masking, unknown fields kept. */
export async function loadMcpConfigRaw(
  root: string,
  opts: McpConfigPersistenceOptions = {},
): Promise<Record<string, unknown>> {
  const path = join(root, MCP_CONFIG_FILE)
  const fallback = structuredClone(DEFAULT_MCP_CONFIG) as Record<
    string,
    unknown
  >
  if (!existsSync(path)) return fallback
  const snapshot = await mcpConfigSnapshot(path, opts.persistenceAdapter).read({
    fallback,
  })
  // Opened, so named edits compare and keep real values; saving seals again.
  const value = openMcpSecrets(snapshot.value, opts.sealer, 'keep')
  if (!objectOrNull(value.servers)) value.servers = {}
  return value
}

/** Apply `change` to every string value under `servers.*.headers|env`. */
function mapSecretFields(
  raw: Record<string, unknown>,
  change: (
    value: string,
    where: { server: string; field: 'headers' | 'env'; name: string },
  ) => string | undefined,
): Record<string, unknown> {
  const next = structuredClone(raw)
  const servers = objectOrNull(next.servers)
  if (!servers) return next
  for (const [server, config] of Object.entries(servers)) {
    const record = objectOrNull(config)
    if (!record) continue
    for (const field of ['headers', 'env'] as const) {
      const values = objectOrNull(record[field])
      if (!values) continue
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== 'string') continue
        const changed = change(value, { server, field, name })
        if (changed === undefined) delete values[name]
        else values[name] = changed
      }
    }
  }
  return next
}

function openMcpSecrets(
  raw: Record<string, unknown>,
  sealer: SecretSealer | null | undefined,
  unreadable: UnreadableSecrets,
): Record<string, unknown> {
  const lost: string[] = []
  const opened = mapSecretFields(raw, (value, { server, field, name }) => {
    if (!isSealedSecret(value)) return value
    try {
      if (sealer)
        return sealer.open(value, mcpSecretContext(server, field, name))
    } catch {
      // Reported below by name only.
    }
    lost.push(`servers.${server}.${field}.${name}`)
    return unreadable === 'keep' ? value : undefined
  })
  if (lost.length && unreadable === 'drop')
    logger.warn('MCP secrets could not be opened with the local key', {
      fields: lost,
    })
  return opened
}

/** `Bearer ${TOKEN}`-style values name an environment variable, not a secret. */
function referencesOnly(value: string): boolean {
  return (
    ENV_PLACEHOLDER_RE.test(value) &&
    value
      .replace(ENV_RE, '')
      .replace(/^\s*(bearer|basic|token)\b/i, '')
      .trim() === ''
  )
}

function secretToSeal(name: string, value: string): boolean {
  return (
    SECRET_FIELD_NAME.test(name) &&
    value.trim() !== '' &&
    !isSealedSecret(value) &&
    !referencesOnly(value)
  )
}

export function sealMcpSecrets(
  raw: Record<string, unknown>,
  sealer: SecretSealer | null | undefined,
): { raw: Record<string, unknown>; sealedPlaintext: boolean } {
  if (!sealer) return { raw, sealedPlaintext: false }
  const canSeal = sealer.available
  let sealedPlaintext = false
  let unsealed = false
  const sealed = mapSecretFields(raw, (value, { server, field, name }) => {
    if (!secretToSeal(name, value)) return value
    if (canSeal)
      try {
        const result = sealer.seal(value, mcpSecretContext(server, field, name))
        sealedPlaintext = true
        return result
      } catch {
        // Reported below; the value is kept rather than lost.
      }
    unsealed = true
    return value
  })
  if (unsealed)
    logger.warn('MCP secrets stay unsealed: the local key is not available')
  return { raw: sealed, sealedPlaintext }
}

function hasUnsealedSecrets(raw: Record<string, unknown>): boolean {
  let found = false
  mapSecretFields(raw, (value, { name }) => {
    if (secretToSeal(name, value)) found = true
    return value
  })
  return found
}

/** `mcp_config.json.pre-seal-<ts>`: the file as it was, plaintext and all. */
async function backupBeforeSealing(path: string): Promise<void> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
    if (!hasUnsealedSecrets(validateRawConfig(JSON.parse(source)))) return
  } catch {
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(`${path}.pre-seal-${stamp}`, 'wx', 0o600)
    await handle.writeFile(source, 'utf8')
    await handle.sync()
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    await handle?.close()
  }
}

interface UrlParts {
  scheme: string
  userinfo: string | null
  host: string
  path: string
  query: Array<{ key: string; value: string | null }> | null
  fragment: string | null
}

const URL_PARTS_RE =
  /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s

/** Split a URL without re-encoding it (placeholders and spelling stay verbatim). */
function splitUrl(value: string): UrlParts | null {
  const match = URL_PARTS_RE.exec(value)
  if (!match) return null
  const authority = match[2] ?? ''
  const at = authority.lastIndexOf('@')
  const query = match[4]
  return {
    scheme: match[1] ?? '',
    userinfo: at >= 0 ? authority.slice(0, at) : null,
    host: at >= 0 ? authority.slice(at + 1) : authority,
    path: match[3] ?? '',
    query:
      query === undefined
        ? null
        : query.split('&').map((part) => {
            const eq = part.indexOf('=')
            return eq < 0
              ? { key: part, value: null }
              : { key: part.slice(0, eq), value: part.slice(eq + 1) }
          }),
    fragment: match[5] ?? null,
  }
}

function joinUrl(parts: UrlParts): string {
  const query =
    parts.query === null
      ? ''
      : `?${parts.query
          .map((pair) =>
            pair.value === null ? pair.key : `${pair.key}=${pair.value}`,
          )
          .join('&')}`
  return (
    parts.scheme +
    (parts.userinfo === null ? '' : `${parts.userinfo}@`) +
    parts.host +
    parts.path +
    query +
    (parts.fragment === null ? '' : `#${parts.fragment}`)
  )
}

/** Editor view of a URL: scheme/host/path stay readable; userinfo, query values, and fragment are secrets. */
export function maskSecretUrl(value: string): string {
  const parts = splitUrl(value)
  if (parts === null) return maskSecretLeaf(value)
  const maskPart = (part: string | null): string | null =>
    part === null || part === '' ? part : maskSecretLeaf(part)
  return joinUrl({
    ...parts,
    userinfo: maskPart(parts.userinfo),
    query:
      parts.query?.map((pair) => ({
        key: pair.key,
        value: maskPart(pair.value),
      })) ?? null,
    fragment: maskPart(parts.fragment),
  })
}

function maskSecretRecord(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, maskSecretLeaf(value)]),
  )
}

function maskSecretLeaf(value: string): string {
  return ENV_PLACEHOLDER_RE.test(value) ? value : MCP_EDITOR_SECRET_MARKER
}

export async function saveMcpConfig(
  root: string,
  raw: Record<string, unknown>,
  opts: McpConfigPersistenceOptions = {},
): Promise<void> {
  if (
    !raw.servers ||
    typeof raw.servers !== 'object' ||
    Array.isArray(raw.servers)
  )
    throw new McpConfigError("mcp_config: 'servers' must be an object")
  const stored = (
    await resolveMcpConfig(
      root,
      {},
      {
        persistenceAdapter: opts.persistenceAdapter,
        sealer: opts.sealer ?? null,
        unreadableSecrets: 'keep',
      },
    )
  ).config
  const data = restoreMcpEditorSecrets(raw, stored)
  if (
    !data.defaults ||
    typeof data.defaults !== 'object' ||
    Array.isArray(data.defaults)
  )
    data.defaults = DEFAULT_MCP_CONFIG.defaults
  const path = join(root, MCP_CONFIG_FILE)
  const sealed = sealMcpSecrets(data, opts.sealer)
  if (sealed.sealedPlaintext) await backupBeforeSealing(path)
  await mcpConfigSnapshot(path, opts.persistenceAdapter).write(sealed.raw)
}

function restoreMcpEditorSecrets(
  raw: Record<string, unknown>,
  stored: MCPConfig,
): Record<string, unknown> {
  const restored = structuredClone(raw)
  const submittedServers = restored.servers as Record<string, unknown>
  for (const [serverName, submittedValue] of Object.entries(submittedServers)) {
    if (
      !submittedValue ||
      typeof submittedValue !== 'object' ||
      Array.isArray(submittedValue)
    )
      continue
    const submitted = submittedValue as Record<string, unknown>
    const previous = stored.servers[serverName]
    if (Array.isArray(submitted.args)) {
      submitted.args = submitted.args.map((value, index) =>
        restoreSecretLeaf(
          value,
          previous?.args[index],
          `servers.${serverName}.args.${index}`,
        ),
      )
    }
    submitted.env = restoreSecretRecord(
      submitted.env,
      previous?.env,
      `servers.${serverName}.env`,
    )
    submitted.headers = restoreSecretRecord(
      submitted.headers,
      previous?.headers,
      `servers.${serverName}.headers`,
    )
    if (typeof submitted.url === 'string') {
      submitted.url = restoreSecretUrl(
        submitted.url,
        previous?.url,
        `servers.${serverName}.url`,
      )
    }
  }
  return restored
}

function restoreSecretRecord(
  submittedValue: unknown,
  previous: Record<string, string> | undefined,
  path: string,
): unknown {
  if (
    !submittedValue ||
    typeof submittedValue !== 'object' ||
    Array.isArray(submittedValue)
  )
    return submittedValue
  const submitted = submittedValue as Record<string, unknown>
  for (const [key, value] of Object.entries(submitted)) {
    submitted[key] = restoreSecretLeaf(value, previous?.[key], `${path}.${key}`)
  }
  return submitted
}

function restoreSecretUrl(
  submitted: string,
  previous: string | null | undefined,
  path: string,
): string {
  if (!submitted.includes(MCP_EDITOR_SECRET_MARKER)) return submitted
  if (submitted === MCP_EDITOR_SECRET_MARKER)
    return restoreSecretLeaf(submitted, previous, path) as string
  const missing = (): Error =>
    new McpConfigError(
      `mcp_config: secret marker has no stored value at ${path}`,
    )
  if (typeof previous !== 'string') throw missing()
  if (maskSecretUrl(previous) === submitted) return previous
  const next = splitUrl(submitted)
  const prior = splitUrl(previous)
  if (next === null || prior === null) throw missing()
  // Masked values never follow the URL to another origin.
  if (
    next.scheme.toLowerCase() !== prior.scheme.toLowerCase() ||
    next.host.toLowerCase() !== prior.host.toLowerCase()
  )
    throw new McpConfigError(
      `mcp_config: masked URL secrets at ${path} can only be kept for the same host`,
    )
  const restorePart = (
    part: string | null,
    stored: string | null | undefined,
  ): string | null => {
    if (part !== MCP_EDITOR_SECRET_MARKER) return part
    if (typeof stored !== 'string') throw missing()
    return stored
  }
  const seen = new Map<string, number>()
  const restored = joinUrl({
    ...next,
    userinfo: restorePart(next.userinfo, prior.userinfo),
    query:
      next.query?.map((pair) => {
        const occurrence = seen.get(pair.key) ?? 0
        seen.set(pair.key, occurrence + 1)
        const stored = prior.query?.filter((item) => item.key === pair.key)[
          occurrence
        ]?.value
        return { key: pair.key, value: restorePart(pair.value, stored) }
      }) ?? null,
    fragment: restorePart(next.fragment, prior.fragment),
  })
  if (restored.includes(MCP_EDITOR_SECRET_MARKER)) throw missing()
  return restored
}

function restoreSecretLeaf(
  submitted: unknown,
  previous: unknown,
  path: string,
): unknown {
  if (submitted !== MCP_EDITOR_SECRET_MARKER) return submitted
  if (typeof previous !== 'string') {
    throw new McpConfigError(
      `mcp_config: secret marker has no stored value at ${path}`,
    )
  }
  return previous
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
      transport: transportValue(obj),
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

/** Explicit transport (client spellings normalized), else url-only → http, else stdio. */
function transportValue(obj: Record<string, unknown>): string {
  const declared = String(obj.transport ?? obj.type ?? '').trim()
  if (declared) return normalizeMcpTransport(declared) ?? declared
  return nullableString(obj.url) && !nullableString(obj.command)
    ? 'http'
    : 'stdio'
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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

/**
 * The user's own file (PL-10, FIX-08): no Emperor version is written into
 * it or read out of it; a `version` key there is the user's.
 */
const MCP_CONFIG_SNAPSHOT_CODEC: SnapshotCodec<Record<string, unknown>> = {
  schemaVersion: 1,
  encode(value) {
    return value
  },
  decode(input) {
    return {
      value: validateRawConfig(input),
      schemaVersion: 1,
    }
  },
}

function mcpConfigSnapshot(
  path: string,
  adapter?: PersistenceAdapter,
): AtomicSnapshot<Record<string, unknown>> {
  return new AtomicSnapshot({
    path,
    codec: MCP_CONFIG_SNAPSHOT_CODEC,
    adapter,
    fileMode: 0o600,
  })
}

function reportMcpConfigRecovery(info: {
  path: string
  backupPath: string
  error: unknown
}): void {
  logger.warn('Invalid MCP config isolated; using defaults', {
    path: info.path,
    backupPath: info.backupPath,
    error:
      info.error instanceof Error ? info.error.message : String(info.error),
  })
}
