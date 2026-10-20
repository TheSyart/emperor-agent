/**
 * The persistent files of an Emperor Home and the version each declares
 * (REL-03). A file a newer Emperor wrote — its version above what this
 * build writes — is read as well as this build can and never rewritten or
 * moved aside; 设置 › 高级 › 存储 names it (`storage.versions`).
 *
 * The version key follows each file's history: files that had none before
 * 0.2 carry `version` (stamped by migration 0-1 or the next save), the
 * others keep the `schemaVersion` older builds already check, and the
 * session index (a list) carries `version` on every entry.
 *
 * Main owns the credential vault and the two download records; Core owns
 * the rest. Loaded on demand (the settings page), never at startup.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CURRENT_DATA_VERSION,
  compareAppVersions,
  readInstalledDataVersion,
} from '../runtime/data-version'
import { declaredVersion, type VersionKey } from '../store/persistence'

export interface DataFileSpec {
  id: string
  /** Relative to the Emperor Home. */
  path: string
  key: VersionKey
  /** The version this build writes. */
  supported: number
  label: string
  owner: 'core' | 'desktop'
}

function file(
  id: string,
  path: string,
  key: VersionKey,
  supported: number,
  label: string,
  owner: DataFileSpec['owner'] = 'core',
): DataFileSpec {
  return { id, path, key, supported, label, owner }
}

export const DATA_FILES: readonly DataFileSpec[] = [
  file('installation', 'installation.json', 'schemaVersion', 1, '安装信息'),
  file('settings', 'settings.json', 'version', 1, '设置'),
  file('modelConfig', 'model_config.json', 'schemaVersion', 2, '模型配置'),
  file('mcpConfig', 'mcp_config.json', 'version', 1, 'MCP 服务器'),
  file('hooks', 'hooks.json', 'version', 1, 'Hooks'),
  file('scheduler', 'scheduler/jobs.json', 'version', 1, '定时任务'),
  file('sessions', 'sessions/index.json', 'version', 1, '会话索引'),
  file(
    'plugins',
    'plugins/installed_plugins.json',
    'schemaVersion',
    1,
    '已安装的插件',
  ),
  file(
    'marketplaces',
    'plugins/known_marketplaces.json',
    'schemaVersion',
    1,
    '插件市场',
  ),
  file(
    'executors',
    'delegations/config.json',
    'schemaVersion',
    1,
    '子智能体设置',
  ),
  file(
    'executorConsent',
    'delegations/consent.json',
    'schemaVersion',
    1,
    '子智能体授权',
  ),
  file(
    'vault',
    'computer-use/vault.json',
    'version',
    3,
    '密码管理器',
    'desktop',
  ),
  file(
    'userDownloads',
    'browser/user-downloads.json',
    'version',
    1,
    '下载记录',
    'desktop',
  ),
  file(
    'agentDownloads',
    'browser/downloads/.index.json',
    'version',
    1,
    'Agent 下载记录',
    'desktop',
  ),
]

export type DataFileStateId = 'ok' | 'newer' | 'unversioned' | 'unreadable'

export interface DataFileState extends Omit<DataFileSpec, 'key'> {
  version: number | null
  state: DataFileStateId
}

/** Every inventory file that exists in `home`, and what it declares. */
export function inspectDataFiles(
  home: string,
  files: readonly DataFileSpec[] = DATA_FILES,
): DataFileState[] {
  const states: DataFileState[] = []
  for (const { key, ...spec } of files) {
    const path = join(home, spec.path)
    if (!existsSync(path)) continue
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      states.push({ ...spec, version: null, state: 'unreadable' })
      continue
    }
    const version = declaredVersion(value, key)
    // An empty session index has no entry to carry a version.
    const empty = Array.isArray(value) && value.length === 0
    states.push({
      ...spec,
      version,
      state:
        version === null
          ? empty
            ? 'ok'
            : 'unversioned'
          : version > spec.supported
            ? 'newer'
            : 'ok',
    })
  }
  return states
}

export interface LastRestore {
  at: string
  status: string
  backup: string | null
  backupCreatedAt: string | null
}

export interface DataVersionsReport {
  appVersion: string
  lastRunVersion: string | null
  previousRunVersion: string | null
  /** The newer release that ran before this one, when this one is older. */
  downgradedFrom: string | null
  dataVersion: number
  supportedDataVersion: number
  files: DataFileState[]
  lastRestore: LastRestore | null
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function lastRestoreOf(home: string): LastRestore | null {
  let text: string
  try {
    text = readFileSync(join(home, 'migrations', 'log.jsonl'), 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('"restore"')) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.kind !== 'restore') continue
      return {
        at: String(entry.at ?? ''),
        status: String(entry.status ?? ''),
        backup: stringOr(entry.backup),
        backupCreatedAt: stringOr(entry.backupCreatedAt),
      }
    } catch {
      // A damaged line: look further back.
    }
  }
  return null
}

/** `storage.versions`: the runs, the data version and every file's state. */
export function dataVersionsReport(
  home: string,
  appVersion: string,
): DataVersionsReport {
  let installation: Record<string, unknown> = {}
  try {
    installation = JSON.parse(
      readFileSync(join(home, 'installation.json'), 'utf8'),
    ) as Record<string, unknown>
  } catch {
    // No installation.json yet: nothing ran before.
  }
  const lastRunVersion = stringOr(installation.lastRunVersion)
  const previousRunVersion = stringOr(installation.previousRunVersion)
  // This run recorded itself last; a newer installation.json was not
  // rewritten, so its last run is the one before this.
  const before =
    lastRunVersion === appVersion ? previousRunVersion : lastRunVersion
  return {
    appVersion,
    lastRunVersion,
    previousRunVersion,
    downgradedFrom:
      before && (compareAppVersions(appVersion, before) ?? 0) < 0
        ? before
        : null,
    dataVersion: readInstalledDataVersion(home),
    supportedDataVersion: CURRENT_DATA_VERSION,
    files: inspectDataFiles(home),
    lastRestore: lastRestoreOf(home),
  }
}
