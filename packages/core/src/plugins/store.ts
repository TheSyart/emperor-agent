import { join, resolve } from 'node:path'
import { AtomicSnapshotSync, type SnapshotCodec } from '../store/persistence'
import { canonicalizeExistingPath, isPathWithin } from '../util/paths'
import {
  assertPluginId,
  isPluginScope,
  type InstalledPluginEntry,
  type InstalledPluginsFileV1,
  type PluginScope,
} from './models'

const EMPTY_INSTALLED: InstalledPluginsFileV1 = {
  schemaVersion: 1,
  plugins: {},
}

const INSTALLED_CODEC: SnapshotCodec<InstalledPluginsFileV1> = {
  schemaVersion: 1,
  encode(value) {
    return value
  },
  decode(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('invalid installed Plugins document')
    const raw = input as Record<string, unknown>
    if (Number(raw.schemaVersion) !== 1)
      throw new Error('unsupported installed Plugins schema')
    const rawPlugins = raw.plugins
    if (
      !rawPlugins ||
      typeof rawPlugins !== 'object' ||
      Array.isArray(rawPlugins)
    )
      throw new Error('invalid installed Plugins map')
    const plugins: Record<string, InstalledPluginEntry[]> = {}
    for (const [pluginId, value] of Object.entries(rawPlugins)) {
      assertPluginId(pluginId)
      if (!Array.isArray(value))
        throw new Error('invalid installed Plugin list')
      plugins[pluginId] = value.map(parseEntry)
    }
    return { schemaVersion: 1, value: { schemaVersion: 1, plugins } }
  },
}

export class PluginStore {
  readonly pluginsRoot: string
  readonly cacheRoot: string
  readonly installedFile: string
  private readonly snapshot: AtomicSnapshotSync<InstalledPluginsFileV1>

  constructor(opts: { pluginsRoot: string }) {
    this.pluginsRoot = resolve(opts.pluginsRoot)
    this.cacheRoot = join(this.pluginsRoot, 'cache')
    this.installedFile = join(this.pluginsRoot, 'installed_plugins.json')
    this.snapshot = new AtomicSnapshotSync({
      path: this.installedFile,
      codec: INSTALLED_CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
    })
  }

  list(pluginId?: string | null): InstalledPluginEntry[] {
    const state = this.read()
    const entries = pluginId
      ? [...(state.plugins[assertPluginId(pluginId)] ?? [])]
      : Object.values(state.plugins).flat()
    return entries.sort((left, right) =>
      `${left.pluginId}:${left.scope}`.localeCompare(
        `${right.pluginId}:${right.scope}`,
      ),
    )
  }

  get(pluginId: string, scope: PluginScope): InstalledPluginEntry | null {
    return (
      this.read().plugins[assertPluginId(pluginId)]?.find(
        (entry) => entry.scope === scope,
      ) ?? null
    )
  }

  upsert(entry: InstalledPluginEntry): InstalledPluginEntry {
    const normalized = this.normalizeEntry(entry)
    const state = this.read()
    const current = state.plugins[normalized.pluginId] ?? []
    state.plugins[normalized.pluginId] = [
      ...current.filter((item) => item.scope !== normalized.scope),
      normalized,
    ]
    this.snapshot.write(state)
    return normalized
  }

  remove(pluginId: string, scope: PluginScope): boolean {
    const id = assertPluginId(pluginId)
    if (!isPluginScope(scope)) throw new Error(`invalid Plugin scope: ${scope}`)
    const state = this.read()
    const current = state.plugins[id] ?? []
    const next = current.filter((entry) => entry.scope !== scope)
    if (next.length === current.length) return false
    if (next.length) state.plugins[id] = next
    else delete state.plugins[id]
    this.snapshot.write(state)
    return true
  }

  ensure(): void {
    const read = this.snapshot.read({ fallback: EMPTY_INSTALLED })
    if (!read.found) this.snapshot.write(cloneState(read.value))
  }

  private read(): InstalledPluginsFileV1 {
    return cloneState(this.snapshot.read({ fallback: EMPTY_INSTALLED }).value)
  }

  private normalizeEntry(entry: InstalledPluginEntry): InstalledPluginEntry {
    const pluginId = assertPluginId(entry.pluginId)
    if (!isPluginScope(entry.scope))
      throw new Error(`invalid Plugin scope: ${String(entry.scope)}`)
    const installPath = resolve(String(entry.installPath ?? ''))
    if (
      !isPathWithin(installPath, this.cacheRoot) ||
      !isPathWithin(
        canonicalizeExistingPath(installPath),
        canonicalizeExistingPath(this.cacheRoot),
      )
    )
      throw new Error('Plugin installPath must be inside the canonical cache')
    if (!/^[a-f0-9]{64}$/i.test(String(entry.digest ?? '')))
      throw new Error('Plugin digest must be a SHA-256 value')
    if (!String(entry.version ?? '').trim())
      throw new Error('Plugin version is required')
    return {
      ...entry,
      pluginId,
      installPath,
      version: String(entry.version).trim(),
      digest: String(entry.digest).toLowerCase(),
      signature: parseSignature(entry.signature, entry.source.kind),
    }
  }
}

function parseEntry(value: unknown): InstalledPluginEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid installed Plugin entry')
  const entry = value as InstalledPluginEntry
  if (!isPluginScope(entry.scope)) throw new Error('invalid Plugin scope')
  if (!entry.source || typeof entry.source !== 'object')
    throw new Error('invalid Plugin source')
  return {
    ...entry,
    signature: parseSignature(entry.signature, entry.source.kind),
  }
}

function parseSignature(
  value: InstalledPluginEntry['signature'],
  sourceKind: InstalledPluginEntry['source']['kind'],
): NonNullable<InstalledPluginEntry['signature']> {
  if (
    value &&
    ['local_user_source', 'verified', 'unverified'].includes(value.status) &&
    (value.publisher === null || typeof value.publisher === 'string')
  )
    return { status: value.status, publisher: value.publisher }
  return {
    status: sourceKind === 'local' ? 'local_user_source' : 'unverified',
    publisher: null,
  }
}

function cloneState(value: InstalledPluginsFileV1): InstalledPluginsFileV1 {
  return {
    schemaVersion: 1,
    plugins: Object.fromEntries(
      Object.entries(value.plugins).map(([id, entries]) => [
        id,
        entries.map((entry) => ({
          ...entry,
          source: { ...entry.source },
          ...(entry.signature ? { signature: { ...entry.signature } } : {}),
        })),
      ]),
    ),
  }
}
