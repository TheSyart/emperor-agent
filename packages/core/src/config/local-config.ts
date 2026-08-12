import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  parsePermissionRules,
  type PermissionRuleDiagnostics,
  type PermissionRuleInput,
  type PermissionRuleLayerInput,
} from '../permissions/rules'
import type { SoftGitRewindMode } from '../checkpoints/soft-git-rewind'
import {
  AtomicSnapshot,
  type PersistenceAdapter,
  type SnapshotCodec,
} from '../store/persistence'

export const LOCAL_CONFIG_FILE = 'settings.json'
export const LEGACY_LOCAL_CONFIG_FILE = 'emperor.local.json'
const PROJECT_CONFIG_MAX_BYTES = 1024 * 1024

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

export interface PermissionPreferences {
  rules: PermissionRuleInput[]
}

export interface WorkspacePreferences {
  fileCheckpoints: { enabled: boolean }
  gitRewind: { mode: SoftGitRewindMode }
}

export type HybridMemoryMode = 'off' | 'eval' | 'on'

export interface MemoryPreferences {
  hybridMemory: HybridMemoryMode
}

export type CodeIntelligenceMode = 'off' | 'eval' | 'on'

export interface CodeIntelligencePreferences {
  mode: CodeIntelligenceMode
}

export interface LocalConfig {
  webui: WebUIPreferences
  desktopPet: DesktopPetPreferences
  prompt: PromptPreferences
  memory: MemoryPreferences
  codeIntelligence: CodeIntelligencePreferences
  workspace: WorkspacePreferences
  permissions: PermissionPreferences
}

export type LocalConfigInput = Omit<
  LocalConfig,
  'memory' | 'codeIntelligence'
> & {
  memory?: MemoryPreferences
  codeIntelligence?: CodeIntelligencePreferences
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
  permissions: PermissionRuleDiagnostics
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
    memory: { hybridMemory: 'off' },
    codeIntelligence: { mode: 'off' },
    workspace: {
      fileCheckpoints: { enabled: false },
      gitRewind: { mode: 'off' },
    },
    permissions: { rules: [] },
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
  const memory = objectOrEmpty(data.memory)
  const codeIntelligence = objectOrEmpty(
    data.codeIntelligence ?? data.code_intelligence,
  )
  const workspace = objectOrEmpty(data.workspace)
  const fileCheckpoints = objectOrEmpty(
    workspace.fileCheckpoints ?? workspace.file_checkpoints,
  )
  const gitRewind = objectOrEmpty(workspace.gitRewind ?? workspace.git_rewind)
  const permissions = objectOrEmpty(data.permissions)
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
    memory: {
      hybridMemory: normalizeHybridMemoryMode(
        memory.hybridMemory ?? memory.hybrid_memory,
      ),
    },
    codeIntelligence: {
      mode: normalizeCodeIntelligenceMode(codeIntelligence.mode),
    },
    workspace: {
      fileCheckpoints: {
        enabled: Boolean(fileCheckpoints.enabled ?? false),
      },
      gitRewind: { mode: normalizeSoftGitRewindMode(gitRewind.mode) },
    },
    permissions: {
      rules: Array.isArray(permissions.rules)
        ? (permissions.rules.filter(
            (item) => item && typeof item === 'object' && !Array.isArray(item),
          ) as PermissionRuleInput[])
        : [],
    },
  }
}

export function localConfigPath(root: string): string {
  return join(resolve(root), LOCAL_CONFIG_FILE)
}

/**
 * Reads only the explicitly supported project-local key. These files cannot
 * redirect Emperor Home/runtime roots or inject credentials/executables.
 */
export function loadProjectPermissionRuleLayers(
  projectRoot: string,
): PermissionRuleLayerInput[] {
  const emperorRoot = join(resolve(projectRoot), '.emperor')
  try {
    const rootStat = lstatSync(emperorRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return []
  } catch {
    return []
  }
  const layers: PermissionRuleLayerInput[] = []
  for (const [file, kind] of [
    ['settings.json', 'project'],
    ['settings.local.json', 'project-local'],
  ] as const) {
    const path = join(emperorRoot, file)
    try {
      const fileStat = lstatSync(path)
      if (
        fileStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        fileStat.size > PROJECT_CONFIG_MAX_BYTES
      )
        continue
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      const data = objectOrEmpty(raw)
      const permissions = objectOrEmpty(data.permissions)
      const rules = Array.isArray(permissions.rules)
        ? (permissions.rules.filter(
            (item) => item && typeof item === 'object' && !Array.isArray(item),
          ) as PermissionRuleInput[])
        : []
      if (rules.length)
        layers.push({
          source: { kind, id: file, trust: 'project' },
          rules,
        })
    } catch {
      // Invalid project candidates are inert; diagnostics can inspect the file.
    }
  }
  return layers
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
    memory: {
      hybridMemory: normalizeHybridMemoryMode(config.memory?.hybridMemory),
    },
    codeIntelligence: {
      mode: normalizeCodeIntelligenceMode(config.codeIntelligence?.mode),
    },
    workspace: {
      fileCheckpoints: {
        enabled: Boolean(config.workspace?.fileCheckpoints?.enabled ?? false),
      },
      gitRewind: {
        mode: normalizeSoftGitRewindMode(config.workspace?.gitRewind?.mode),
      },
    },
    permissions: {
      rules: Array.isArray(config.permissions?.rules)
        ? config.permissions.rules
        : [],
    },
  }
  await localConfigSnapshot(path, opts.persistenceAdapter).write(payload)
  return path
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

export function normalizeSoftGitRewindMode(value: unknown): SoftGitRewindMode {
  return value === 'eval' || value === 'on' ? value : 'off'
}

export function normalizeHybridMemoryMode(value: unknown): HybridMemoryMode {
  return value === 'eval' || value === 'on' ? value : 'off'
}

export function normalizeCodeIntelligenceMode(
  value: unknown,
): CodeIntelligenceMode {
  return value === 'eval' || value === 'on' ? value : 'off'
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
      const raw = JSON.parse((await readFile(path, 'utf8')) || '{}')
      const parsed = parseLocalConfig(raw)
      const permissionDiagnostics = parsePermissionRules(
        parsed.permissions.rules,
      ).diagnostics
      status = 'ok'
      return {
        path,
        exists,
        status,
        error,
        permissions: permissionDiagnostics,
        corruptBackups: await listCorruptBackups(path),
      }
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
    permissions: parsePermissionRules([]).diagnostics,
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
