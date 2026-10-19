import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { BrowserPreferences } from '../runtime/types'
import {
  AtomicSnapshot,
  NODE_PERSISTENCE_ADAPTER,
  type PersistenceAdapter,
  type SnapshotCodec,
} from '../store/persistence'

export type { BrowserPreferences }

export const LOCAL_CONFIG_FILE = 'settings.json'
export const LEGACY_LOCAL_CONFIG_FILE = 'emperor.local.json'

export interface WebUIPreferences {
  host: string
  port: number
  openBrowser: boolean
}

export interface DesktopPetPreferences {
  enabled: boolean
  autoStartWithWebui: boolean
}

export type PromptProfile = 'classic' | 'neutral' | 'technical'

export interface PromptPreferences {
  profile: PromptProfile
}

/**
 * 设置 › 高级 › 网络工具: whether the Agent gets `web_fetch` and (where the
 * provider offers it) `web_search`. Both default on.
 */
export interface WebToolPreferences {
  webFetch: boolean
  webSearch: boolean
}

/**
 * `settings.json` preferences. Retired keys from the old kernel
 * (`permissions.rules`, `workspace.fileCheckpoints` / `workspace.gitRewind`,
 * `memory.hybridMemory`, `codeIntelligence`) are ignored when reading so old
 * files keep loading; they are not written back.
 */
export interface LocalConfig {
  webui: WebUIPreferences
  desktopPet: DesktopPetPreferences
  prompt: PromptPreferences
  browser: BrowserPreferences
  webTools: WebToolPreferences
}

/** What a save takes: a missing `browser` or `webTools` writes its defaults. */
export type LocalConfigInput = Omit<LocalConfig, 'browser' | 'webTools'> & {
  browser?: BrowserPreferences
  webTools?: WebToolPreferences
}

export function defaultWebToolPreferences(): WebToolPreferences {
  return { webFetch: true, webSearch: true }
}

/** Each switch falls back to its default when missing or not a boolean. */
export function normalizeWebToolPreferences(
  value: unknown,
): WebToolPreferences {
  const data = objectOrEmpty(value)
  const defaults = defaultWebToolPreferences()
  return {
    webFetch:
      typeof data.webFetch === 'boolean' ? data.webFetch : defaults.webFetch,
    webSearch:
      typeof data.webSearch === 'boolean' ? data.webSearch : defaults.webSearch,
  }
}

export function defaultBrowserPreferences(): BrowserPreferences {
  return {
    linkTarget: 'system',
    localTarget: 'builtin',
    showFullUrl: true,
    history: true,
    downloadDirectory: null,
    askWhereToSave: false,
  }
}

/** Longest download folder path kept (longer ones go back to the default). */
export const DOWNLOAD_DIRECTORY_MAX_LENGTH = 4_096

/**
 * The user's download folder when it is a usable absolute path, else null
 * (the system Downloads folder).
 */
export function validDownloadDirectory(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= DOWNLOAD_DIRECTORY_MAX_LENGTH &&
    !value.includes('\0') &&
    isAbsolute(value)
    ? value
    : null
}

export interface LocalConfigBackup {
  path: string
  bytes: number
  updatedAt: number
}

export interface LocalConfigDiagnostics {
  path: string
  exists: boolean
  status: 'missing' | 'ok' | 'corrupt'
  error: string
  corruptBackups: LocalConfigBackup[]
}

export interface LocalConfigPersistenceOptions {
  persistenceAdapter?: PersistenceAdapter
}

function defaultLocalConfig(): LocalConfig {
  return {
    webui: { host: '127.0.0.1', port: 8765, openBrowser: false },
    desktopPet: { enabled: false, autoStartWithWebui: true },
    prompt: { profile: 'technical' },
    browser: defaultBrowserPreferences(),
    webTools: defaultWebToolPreferences(),
  }
}

function objectOrEmpty(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function validPort(value: unknown, fallback: number): number {
  const port =
    typeof value === 'number'
      ? Math.trunc(value)
      : Number.parseInt(String(value), 10)
  return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : fallback
}

export function parseLocalConfig(
  raw: Record<string, any> | null | undefined,
): LocalConfig {
  const data = objectOrEmpty(raw)
  const webui = objectOrEmpty(data.webui)
  let desktopPet = objectOrEmpty(data.desktopPet)
  if (Object.keys(desktopPet).length === 0)
    desktopPet = objectOrEmpty(data.desktop_pet)
  const prompt = objectOrEmpty(data.prompt)
  const browser = normalizeBrowserPreferences(data.browser)
  return {
    webui: {
      host: String(webui.host || '127.0.0.1'),
      port: validPort(webui.port, 8765),
      openBrowser: Boolean(webui.openBrowser ?? webui.open_browser ?? false),
    },
    desktopPet: {
      enabled: Boolean(desktopPet.enabled ?? false),
      autoStartWithWebui: Boolean(
        desktopPet.autoStartWithWebui ??
        desktopPet.auto_start_with_webui ??
        true,
      ),
    },
    prompt: {
      profile: normalizePromptProfile(prompt.profile),
    },
    browser,
    webTools: normalizeWebToolPreferences(data.webTools),
  }
}

/**
 * Unknown or malformed fields fall back to the defaults one by one (a
 * download folder that is not an absolute path means the system one); the
 * retired `enabled` switch is dropped.
 */
export function normalizeBrowserPreferences(
  value: unknown,
): BrowserPreferences {
  const data = objectOrEmpty(value)
  const defaults = defaultBrowserPreferences()
  return {
    linkTarget:
      data.linkTarget === 'builtin' || data.linkTarget === 'system'
        ? data.linkTarget
        : defaults.linkTarget,
    localTarget:
      data.localTarget === 'builtin' || data.localTarget === 'system'
        ? data.localTarget
        : defaults.localTarget,
    showFullUrl:
      typeof data.showFullUrl === 'boolean'
        ? data.showFullUrl
        : defaults.showFullUrl,
    history:
      typeof data.history === 'boolean' ? data.history : defaults.history,
    downloadDirectory: validDownloadDirectory(data.downloadDirectory),
    askWhereToSave:
      typeof data.askWhereToSave === 'boolean'
        ? data.askWhereToSave
        : defaults.askWhereToSave,
  }
}

export function localConfigPath(root: string): string {
  return join(resolve(root), LOCAL_CONFIG_FILE)
}

export async function loadLocalConfig(
  root: string,
  opts: { preserveCorrupt?: boolean } & LocalConfigPersistenceOptions = {},
): Promise<LocalConfig> {
  const path = localConfigPath(root)
  if (opts.preserveCorrupt !== false)
    return (
      await localConfigSnapshot(path, opts.persistenceAdapter).read({
        fallback: defaultLocalConfig(),
      })
    ).value

  if (!existsSync(path)) return defaultLocalConfig()
  try {
    return parseLocalConfig(JSON.parse((await readFile(path, 'utf8')) || '{}'))
  } catch {
    return defaultLocalConfig()
  }
}

export async function saveLocalConfig(
  root: string,
  config: LocalConfigInput,
  opts: LocalConfigPersistenceOptions = {},
): Promise<string> {
  const path = localConfigPath(root)
  const payload: LocalConfig = {
    webui: {
      host: config.webui.host,
      port: config.webui.port,
      openBrowser: config.webui.openBrowser,
    },
    desktopPet: {
      enabled: config.desktopPet.enabled,
      autoStartWithWebui: config.desktopPet.autoStartWithWebui,
    },
    prompt: {
      profile: normalizePromptProfile(config.prompt?.profile),
    },
    browser: normalizeBrowserPreferences(config.browser),
    webTools: normalizeWebToolPreferences(config.webTools),
  }
  const shared = await sharedSettings(path, opts.persistenceAdapter)
  await localConfigSnapshot(path, opts.persistenceAdapter).write({
    ...shared,
    ...payload,
  })
  return path
}

/**
 * settings.json keys other services own (plugins/service.ts writes
 * `enabledPlugins`): a save keeps them; retired and unknown keys go.
 */
const SHARED_SETTINGS_KEYS = ['enabledPlugins'] as const

async function sharedSettings(
  path: string,
  adapter: PersistenceAdapter = NODE_PERSISTENCE_ADAPTER,
): Promise<Record<string, unknown>> {
  let raw: Record<string, unknown>
  try {
    if (!(await adapter.exists(path))) return {}
    raw = objectOrEmpty(JSON.parse(await adapter.readText(path)))
  } catch {
    return {}
  }
  return Object.fromEntries(
    SHARED_SETTINGS_KEYS.filter((key) => key in raw).map((key) => [
      key,
      raw[key],
    ]),
  )
}

const LOCAL_CONFIG_CODEC: SnapshotCodec<LocalConfig> = {
  schemaVersion: 1,
  encode(value) {
    return value
  },
  decode(input) {
    return {
      value: parseLocalConfig(
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {},
      ),
      schemaVersion: 1,
    }
  },
}

function localConfigSnapshot(
  path: string,
  adapter?: PersistenceAdapter,
): AtomicSnapshot<LocalConfig> {
  return new AtomicSnapshot({
    path,
    codec: LOCAL_CONFIG_CODEC,
    adapter,
    fileMode: 0o600,
  })
}

export function normalizePromptProfile(value: unknown): PromptProfile {
  return value === 'classic' || value === 'neutral' || value === 'technical'
    ? value
    : 'technical'
}

export function mergeWebuiOverrides(
  config: LocalConfig,
  overrides: {
    host?: string | null
    port?: number | null
    openBrowser?: boolean | null
  } = {},
): WebUIPreferences {
  return {
    host: String(overrides.host || config.webui.host || '127.0.0.1'),
    port: validPort(overrides.port ?? config.webui.port, 8765),
    openBrowser:
      overrides.openBrowser === null || overrides.openBrowser === undefined
        ? config.webui.openBrowser
        : Boolean(overrides.openBrowser),
  }
}

export async function localConfigDiagnostics(
  root: string,
): Promise<LocalConfigDiagnostics> {
  const path = localConfigPath(root)
  const exists = existsSync(path)
  let status: LocalConfigDiagnostics['status'] = 'missing'
  let error = ''
  if (exists) {
    try {
      parseLocalConfig(JSON.parse((await readFile(path, 'utf8')) || '{}'))
      status = 'ok'
    } catch (err) {
      status = 'corrupt'
      error = err instanceof Error ? err.message : String(err)
    }
  }
  return {
    path,
    exists,
    status,
    error,
    corruptBackups: await listCorruptBackups(path),
  }
}

async function listCorruptBackups(path: string): Promise<LocalConfigBackup[]> {
  const parent = dirname(path)
  const prefix = `${LOCAL_CONFIG_FILE}.corrupt-`
  const names = await readdir(parent).catch(() => [])
  const backups: LocalConfigBackup[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const fullPath = join(parent, name)
    const info = await stat(fullPath).catch(() => null)
    if (!info) continue
    backups.push({
      path: fullPath,
      bytes: info.size,
      updatedAt: info.mtimeMs / 1000,
    })
  }
  backups.sort((a, b) => b.updatedAt - a.updatedAt)
  return backups.slice(0, 10)
}
