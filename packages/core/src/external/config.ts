import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ConfigResolver,
  defineConfigKey,
  type ConfigCandidate,
  type Resolved,
} from '../config/resolver'

export const EXTERNAL_CONFIG_FILE = 'external_config.json'
export const EXTERNAL_CONFIG_VERSION = 1

export type ExternalAdapterMode = 'off' | 'eval' | 'on'

export interface SignedWebhookConfig {
  mode: ExternalAdapterMode
  bindHost: '127.0.0.1' | '::1' | 'localhost'
  port: number
  path: string
  sessionId: string
  keyId: string
  secretEnv: string
  outboundUrl: string | null
  requestsPerMinute: number
  burst: number
  maxBodyBytes: number
  timestampSkewSeconds: number
  outboundTimeoutMs: number
}

export interface ExternalConfig {
  version: 1
  signedWebhook: SignedWebhookConfig
}

export interface ExternalConfigDiagnostics {
  path: string
  exists: boolean
  status: 'missing' | 'ok' | 'invalid'
  error: string | null
  backupPath: string | null
}

export interface LoadedExternalConfig {
  config: ExternalConfig
  resolution: Resolved<SignedWebhookConfig>
  diagnostics: ExternalConfigDiagnostics
}

export const DEFAULT_SIGNED_WEBHOOK_CONFIG: Readonly<SignedWebhookConfig> =
  Object.freeze({
    mode: 'off',
    bindHost: '127.0.0.1',
    port: 9876,
    path: '/v1/external/events',
    sessionId: '',
    keyId: '',
    secretEnv: '',
    outboundUrl: null,
    requestsPerMinute: 60,
    burst: 10,
    maxBodyBytes: 262_144,
    timestampSkewSeconds: 300,
    outboundTimeoutMs: 10_000,
  })

const ROOT_FIELDS = new Set(['version', 'signedWebhook'])
const SIGNED_WEBHOOK_FIELDS = new Set([
  'mode',
  'bindHost',
  'port',
  'path',
  'sessionId',
  'keyId',
  'secretEnv',
  'outboundUrl',
  'requestsPerMinute',
  'burst',
  'maxBodyBytes',
  'timestampSkewSeconds',
  'outboundTimeoutMs',
])

export function parseExternalConfig(raw: unknown): ExternalConfig {
  const root = strictRecord(raw, 'external config')
  rejectUnknown(root, ROOT_FIELDS, 'external config')
  if (root.version !== EXTERNAL_CONFIG_VERSION)
    throw new Error(
      `external config version must be ${EXTERNAL_CONFIG_VERSION}`,
    )
  const input =
    root.signedWebhook === undefined
      ? {}
      : strictRecord(root.signedWebhook, 'signedWebhook')
  rejectUnknown(input, SIGNED_WEBHOOK_FIELDS, 'signedWebhook')

  const mode = parseMode(input.mode)
  const bindHost = parseLoopbackHost(
    input.bindHost ?? DEFAULT_SIGNED_WEBHOOK_CONFIG.bindHost,
  )
  const outboundUrl = parseOutboundUrl(input.outboundUrl)
  const secretEnv = parseEnvironmentName(input.secretEnv)
  const sessionId = boundedString(input.sessionId, 128, 'sessionId')
  const keyId = boundedKeyId(input.keyId)
  const config: SignedWebhookConfig = {
    mode,
    bindHost,
    port: boundedInteger(
      input.port,
      DEFAULT_SIGNED_WEBHOOK_CONFIG.port,
      1,
      65_535,
      'port',
    ),
    path: parsePath(input.path ?? DEFAULT_SIGNED_WEBHOOK_CONFIG.path),
    sessionId,
    keyId,
    secretEnv,
    outboundUrl,
    requestsPerMinute: boundedInteger(
      input.requestsPerMinute,
      DEFAULT_SIGNED_WEBHOOK_CONFIG.requestsPerMinute,
      1,
      600,
      'requestsPerMinute',
    ),
    burst: boundedInteger(
      input.burst,
      DEFAULT_SIGNED_WEBHOOK_CONFIG.burst,
      1,
      600,
      'burst',
    ),
    maxBodyBytes: boundedInteger(
      input.maxBodyBytes,
      DEFAULT_SIGNED_WEBHOOK_CONFIG.maxBodyBytes,
      1_024,
      1_048_576,
      'maxBodyBytes',
    ),
    timestampSkewSeconds: boundedInteger(
      input.timestampSkewSeconds,
      DEFAULT_SIGNED_WEBHOOK_CONFIG.timestampSkewSeconds,
      30,
      900,
      'timestampSkewSeconds',
    ),
    outboundTimeoutMs: boundedInteger(
      input.outboundTimeoutMs,
      DEFAULT_SIGNED_WEBHOOK_CONFIG.outboundTimeoutMs,
      1_000,
      60_000,
      'outboundTimeoutMs',
    ),
  }
  if (config.burst > config.requestsPerMinute)
    throw new Error('signedWebhook burst cannot exceed requestsPerMinute')
  if (mode !== 'off') {
    if (!config.sessionId)
      throw new Error(`signedWebhook sessionId is required for mode ${mode}`)
    if (!config.keyId)
      throw new Error(`signedWebhook keyId is required for mode ${mode}`)
    if (!config.secretEnv)
      throw new Error(`signedWebhook secretEnv is required for mode ${mode}`)
  }
  return { version: EXTERNAL_CONFIG_VERSION, signedWebhook: config }
}

export function resolveSignedWebhookConfig(
  candidates: readonly ConfigCandidate<SignedWebhookConfig>[] = [],
): Resolved<SignedWebhookConfig> {
  const key = defineConfigKey<SignedWebhookConfig>({
    id: 'external.signedWebhook',
    builtin: { ...DEFAULT_SIGNED_WEBHOOK_CONFIG },
    secretPaths: ['sessionId', 'secretEnv', 'outboundUrl'],
  })
  return new ConfigResolver().resolve(key, { candidates })
}

export function externalConfigPath(root: string): string {
  return join(resolve(root), EXTERNAL_CONFIG_FILE)
}

export async function loadExternalConfig(
  root: string,
  opts: { preserveInvalid?: boolean } = {},
): Promise<LoadedExternalConfig> {
  const path = externalConfigPath(root)
  if (!existsSync(path)) {
    const config = parseExternalConfig({ version: EXTERNAL_CONFIG_VERSION })
    return {
      config,
      resolution: resolveSignedWebhookConfig(),
      diagnostics: {
        path,
        exists: false,
        status: 'missing',
        error: null,
        backupPath: null,
      },
    }
  }
  try {
    const config = parseExternalConfig(
      JSON.parse((await readFile(path, 'utf8')) || '{}'),
    )
    return {
      config,
      resolution: resolveSignedWebhookConfig([
        {
          source: {
            kind: 'user',
            id: EXTERNAL_CONFIG_FILE,
            trust: 'trusted',
          },
          value: config.signedWebhook,
        },
      ]),
      diagnostics: {
        path,
        exists: true,
        status: 'ok',
        error: null,
        backupPath: null,
      },
    }
  } catch (error) {
    const backupPath =
      opts.preserveInvalid === false ? null : await preserveInvalid(path)
    const config = parseExternalConfig({ version: EXTERNAL_CONFIG_VERSION })
    return {
      config,
      resolution: resolveSignedWebhookConfig(),
      diagnostics: {
        path,
        exists: true,
        status: 'invalid',
        error: safeConfigError(error),
        backupPath,
      },
    }
  }
}

function parseMode(value: unknown): ExternalAdapterMode {
  if (value === undefined) return 'off'
  if (value === 'off' || value === 'eval' || value === 'on') return value
  throw new Error('signedWebhook mode must be off, eval, or on')
}

function parseLoopbackHost(value: unknown): SignedWebhookConfig['bindHost'] {
  const host = String(value ?? '').trim()
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost')
    return host
  throw new Error('signedWebhook bindHost must be a loopback host')
}

function parseOutboundUrl(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '')
    return null
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw new Error('signedWebhook outboundUrl must be a valid HTTPS URL')
  }
  if (url.protocol !== 'https:')
    throw new Error('signedWebhook outboundUrl must use HTTPS')
  if (url.username || url.password)
    throw new Error('signedWebhook outboundUrl must not contain userinfo')
  if (url.hash)
    throw new Error('signedWebhook outboundUrl must not contain a fragment')
  return url.toString()
}

function parseEnvironmentName(value: unknown): string {
  if (value === undefined || value === null || String(value).trim() === '')
    return ''
  const name = String(value).trim()
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name))
    throw new Error(
      'signedWebhook secretEnv must be an uppercase environment variable name',
    )
  return name
}

function parsePath(value: unknown): string {
  const path = String(value ?? '').trim()
  if (
    !path.startsWith('/') ||
    path.length > 256 ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('\\') ||
    containsControlCharacter(path)
  )
    throw new Error('signedWebhook path must be a bounded absolute URL path')
  return path
}

function boundedString(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return ''
  const text = String(value).trim()
  if (text.length > max || containsControlCharacter(text))
    throw new Error(`signedWebhook ${label} is invalid`)
  return text
}

function boundedKeyId(value: unknown): string {
  const keyId = boundedString(value, 128, 'keyId')
  if (keyId && !/^[A-Za-z0-9._:-]+$/.test(keyId))
    throw new Error('signedWebhook keyId is invalid')
  return keyId
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`signedWebhook ${label} must be ${min}..${max}`)
  return parsed
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be a plain object`)
  return value as Record<string, unknown>
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()
  if (unknown.length)
    throw new Error(`${label} contains unknown field ${unknown[0]}`)
}

async function preserveInvalid(path: string): Promise<string | null> {
  const backup = `${path}.corrupt-${Math.floor(Date.now() / 1000)}-${randomUUID().replaceAll('-', '').slice(0, 8)}`
  try {
    await rename(path, backup)
    return backup
  } catch {
    return null
  }
}

function safeConfigError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/[\r\n\t]/g, ' ').slice(0, 500)
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return true
  }
  return false
}
