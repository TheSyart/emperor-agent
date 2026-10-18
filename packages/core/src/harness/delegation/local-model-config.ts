import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parse, stringify } from 'smol-toml'
import { durableReplaceSync } from '../../store/persistence'
import { DelegationError } from './types'
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined
export function readModelFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  const data = readFileSync(path)
  if (data.length > 2 * 1024 * 1024)
    throw new DelegationError(
      'EXECUTOR_CONFIG_INVALID',
      'local model configuration exceeds byte limit',
    )
  return data.toString('utf8')
}
/** The user's Codex config.toml with the selected profile layered on. */
export function readCodexModelConfig(source: string): Record<string, unknown> {
  let config: Record<string, unknown> = {}
  try {
    const raw = readModelFile(join(source, 'config.toml'))
    if (raw) config = parse(raw)
    const selected = text(config.profile)
    if (selected) {
      if (!/^[a-zA-Z0-9_-]+$/.test(selected)) throw Error('invalid profile')
      const file = readModelFile(join(source, selected + '.config.toml'))
      const layer = file
        ? parse(file)
        : object(object(config.profiles)[selected])
      if (!Object.keys(layer).length) throw Error('missing profile')
      config = { ...config, ...layer }
    }
  } catch {
    throw new DelegationError(
      'EXECUTOR_CONFIG_INVALID',
      'Codex model configuration could not be read',
    )
  }
  return config
}
/**
 * Environment variables the selected provider reads its credentials from
 * (`env_key`, `env_http_headers`). Unreadable configuration names none; it is
 * reported when the configuration is inherited.
 */
export function codexProviderVariables(source: string): string[] {
  let config: Record<string, unknown>
  try {
    config = readCodexModelConfig(source)
  } catch {
    return []
  }
  const provider = object(
    object(config.model_providers)[text(config.model_provider) ?? 'openai'],
  )
  return [
    ...new Set(
      [
        text(provider.env_key),
        ...Object.values(object(provider.env_http_headers)).map(text),
      ].filter((name): name is string => !!name),
    ),
  ].sort()
}
export function inheritCodexModels(
  source: string,
  target: string,
  ambient: NodeJS.ProcessEnv,
  env: Record<string, string>,
  secrets: string[],
) {
  const config = readCodexModelConfig(source)
  const safe: Record<string, unknown> = {}
  for (const key of ['model', 'model_provider', 'model_reasoning_effort'])
    if (text(config[key])) safe[key] = text(config[key])
  let providerId = text(config.model_provider) ?? 'openai'
  let provider = object(object(config.model_providers)[providerId])
  if (
    providerId === 'openai' &&
    !text(provider.base_url) &&
    text(ambient.OPENAI_BASE_URL)
  ) {
    providerId = 'emperor-local'
    safe.model_provider = providerId
    provider = {
      name: 'Local endpoint',
      base_url: ambient.OPENAI_BASE_URL,
      wire_api: 'responses',
      requires_openai_auth: !ambient.OPENAI_API_KEY,
      ...(ambient.OPENAI_API_KEY ? { env_key: 'OPENAI_API_KEY' } : {}),
    }
  }
  if (Object.keys(provider).length) {
    if (provider.auth)
      throw new DelegationError(
        'AUTH_ROUTE_UNSUPPORTED',
        'command-based provider authentication is not supported by managed delegation',
      )
    const picked: Record<string, unknown> = {}
    for (const key of [
      'name',
      'base_url',
      'wire_api',
      'requires_openai_auth',
      'supports_websockets',
      'request_max_retries',
      'stream_max_retries',
      'stream_idle_timeout_ms',
    ]) {
      const v = provider[key]
      if (['string', 'boolean', 'number'].includes(typeof v)) picked[key] = v
    }
    const sourceKey = text(provider.env_key),
      bearer = text(provider.experimental_bearer_token)
    if (sourceKey || bearer) {
      const value = bearer ?? ambient[sourceKey!]
      if (!value)
        throw new DelegationError(
          'AUTH_REQUIRED',
          'configured Codex provider credential is unavailable',
        )
      env.EMPEROR_CODEX_PROVIDER_TOKEN = value
      picked.env_key = 'EMPEROR_CODEX_PROVIDER_TOKEN'
      secrets.push(value)
    }
    const headers: Record<string, string> = {},
      envHeaders: Record<string, string> = {}
    for (const [key, v] of Object.entries(object(provider.http_headers)))
      if (typeof v === 'string') {
        headers[key] = v
        secrets.push(v)
      }
    for (const [key, v] of Object.entries(object(provider.env_http_headers)))
      if (typeof v === 'string' && ambient[v]) {
        const name = 'EMPEROR_CODEX_HEADER_' + Object.keys(envHeaders).length
        env[name] = ambient[v]!
        envHeaders[key] = name
        secrets.push(env[name]!)
      }
    if (Object.keys(headers).length) picked.http_headers = headers
    if (Object.keys(envHeaders).length) picked.env_http_headers = envHeaders
    // Azure needs `api-version`; other gateways put routing keys here.
    const query: Record<string, string> = {}
    for (const [key, v] of Object.entries(object(provider.query_params)).slice(
      0,
      32,
    ))
      if (
        typeof v === 'string' &&
        key.length > 0 &&
        key.length <= 256 &&
        v.length <= 4096
      ) {
        query[key] = v
        if (/key|token|secret|sig|password|auth/i.test(key)) secrets.push(v)
      }
    if (Object.keys(query).length) picked.query_params = query
    safe.model_providers = { [providerId]: picked }
    if (text(provider.base_url)) env.OPENAI_BASE_URL = text(provider.base_url)!
  }
  const catalog = text(config.model_catalog_json)
  if (catalog) {
    try {
      const raw = readModelFile(
        isAbsolute(catalog) ? catalog : resolve(source, catalog),
      )
      if (!raw) throw Error('missing catalog')
      JSON.parse(raw)
      const path = join(target, 'model-catalog.json')
      durableReplaceSync(path, raw)
      safe.model_catalog_json = path
    } catch {
      throw new DelegationError(
        'EXECUTOR_CONFIG_INVALID',
        'Codex model catalog could not be read',
      )
    }
  }
  if (Object.keys(safe).length)
    durableReplaceSync(
      join(target, 'config.toml'),
      stringify(safe as Parameters<typeof stringify>[0]),
    )
  const model = text(safe.model)
  if (model) env.EMPEROR_EXECUTOR_MODEL = model
  env.EMPEROR_EXECUTOR_PROVIDER = providerId
  env.EMPEROR_EXECUTOR_CONFIG_FINGERPRINT = createHash('sha256')
    .update(
      JSON.stringify({
        safe: {
          ...safe,
          ...(safe.model_catalog_json
            ? {
                model_catalog_json: readFileSync(
                  String(safe.model_catalog_json),
                  'utf8',
                ),
              }
            : {}),
        },
        secrets,
      }),
    )
    .digest('hex')
  // Custom Responses providers may intentionally be local and unauthenticated.
  return (
    Object.keys(provider).length > 0 && provider.requires_openai_auth !== true
  )
}
export function claudeModelSettings(settings: Record<string, unknown>) {
  const safe: Record<string, unknown> = {}
  if (text(settings.model)) safe.model = text(settings.model)
  for (const key of ['availableModels'])
    if (Array.isArray(settings[key]))
      safe[key] = (settings[key] as unknown[])
        .filter((v) => typeof v === 'string')
        .slice(0, 128)
  if (typeof settings.enforceAvailableModels === 'boolean')
    safe.enforceAvailableModels = settings.enforceAvailableModels
  const bounded = (v: unknown, max = 256): v is string =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  const mappings = Object.fromEntries(
    Object.entries(object(settings.modelOverrides))
      .filter(([k, v]) => bounded(k) && bounded(v))
      .slice(0, 128),
  )
  if (Object.keys(mappings).length) safe.modelOverrides = mappings
  const picker = object(settings.modelPicker)
  if (Array.isArray(picker.options)) {
    safe.modelPicker = {
      options: picker.options
        .slice(0, 128)
        .map(object)
        .filter((row) => bounded(row.model))
        .map((row) => ({
          model: row.model,
          ...Object.fromEntries(
            ['label', 'description', 'behavesAs']
              .filter((k) => bounded(row[k], k === 'description' ? 1024 : 256))
              .map((k) => [k, row[k]]),
          ),
        })),
      ...(typeof picker.replaceBuiltInOptions === 'boolean'
        ? { replaceBuiltInOptions: picker.replaceBuiltInOptions }
        : {}),
    }
  }
  return safe
}
