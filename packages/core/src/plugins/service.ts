import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { canonicalizeExistingPath, isPathWithin } from '../util/paths'
import { extractBoundedZip } from '../environment/zip'
import { isPublicHttpRedirectResponse } from '../network/public-http'
import type { WebFetchClient } from '../tools/web-fetch'
import {
  assertPluginId,
  isPluginScope,
  type ConfirmedPluginInstall,
  type InstalledPluginEntry,
  type PluginInstallPreview,
  type PluginInstallSource,
  type PluginManifestV1,
  type PluginOperationResult,
  type PluginScope,
  type PluginScopeTarget,
  type PluginSource,
  type PluginSummary,
} from './models'
import { PluginStore } from './store'

const MANIFEST_PATH = join('.emperor-plugin', 'plugin.json')
const MAX_PLUGIN_FILES = 4_000
const MAX_PLUGIN_FILE_BYTES = 20 * 1024 * 1024
const MAX_PLUGIN_TOTAL_BYTES = 200 * 1024 * 1024
const PREVIEW_ID = /^plugin_preview_[a-f0-9]{24}$/

interface PreviewState extends PluginInstallPreview {
  readonly payloadRoot: string
  readonly manifest: PluginManifestV1
}

export interface PluginApplicationServiceOptions {
  readonly emperorHome: string
  readonly activeWorkspaceRoot?: (() => string | null) | null
  readonly onChanged?: (() => void) | null
  readonly now?: () => Date
  readonly idFactory?: () => string
  readonly webFetchClient?: WebFetchClient | null
}

export class PluginApplicationService {
  readonly emperorHome: string
  readonly pluginsRoot: string
  readonly stagingRoot: string
  readonly cacheRoot: string
  readonly store: PluginStore
  private readonly activeWorkspaceRoot: () => string | null
  private readonly onChanged: () => void
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly webFetchClient: WebFetchClient | null
  private readonly previews = new Map<string, PreviewState>()

  constructor(opts: PluginApplicationServiceOptions) {
    this.emperorHome = resolve(opts.emperorHome)
    this.pluginsRoot = join(this.emperorHome, 'plugins')
    this.stagingRoot = join(this.pluginsRoot, 'staging')
    this.cacheRoot = join(this.pluginsRoot, 'cache')
    this.store = new PluginStore({ pluginsRoot: this.pluginsRoot })
    this.activeWorkspaceRoot = opts.activeWorkspaceRoot ?? (() => null)
    this.onChanged = opts.onChanged ?? (() => {})
    this.now = opts.now ?? (() => new Date())
    this.idFactory =
      opts.idFactory ??
      (() => `plugin_preview_${randomBytes(12).toString('hex')}`)
    this.webFetchClient = opts.webFetchClient ?? null
    mkdirPrivate(this.stagingRoot)
    mkdirPrivate(this.cacheRoot)
    mkdirPrivate(join(this.pluginsRoot, 'data'))
    this.store.ensure()
  }

  list(): PluginSummary[] {
    const installed = this.store.list()
    const keys = new Set(
      installed.map((entry) => `${entry.pluginId}\0${entry.scope}`),
    )
    for (const scope of ['user', 'project', 'local'] as const) {
      for (const pluginId of Object.keys(this.readIntent(scope)))
        keys.add(`${pluginId}\0${scope}`)
    }
    return [...keys]
      .map((key) => {
        const [pluginId, scope] = key.split('\0') as [string, PluginScope]
        return this.summary(pluginId, scope)
      })
      .sort((left, right) =>
        `${left.pluginId}:${left.scope}`.localeCompare(
          `${right.pluginId}:${right.scope}`,
        ),
      )
  }

  async inspect(source: PluginInstallSource): Promise<PluginInstallPreview> {
    const previewId = this.idFactory()
    if (!PREVIEW_ID.test(previewId))
      throw new Error('invalid Plugin preview id')
    const previewRoot = join(this.stagingRoot, previewId)
    if (existsSync(previewRoot)) throw new Error('Plugin preview id collision')
    mkdirPrivate(previewRoot)
    const payloadRoot = join(previewRoot, 'payload')
    try {
      const resolvedSource = await this.resolveInspectionSource(
        source,
        previewRoot,
      )
      const sourceRoot = resolvedSource.root
      const tree = inspectTree(sourceRoot)
      cpSync(sourceRoot, payloadRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
      })
      const manifest = readManifest(payloadRoot)
      validateManifestPaths(payloadRoot, manifest)
      const digest = digestTree(payloadRoot)
      const preview: PreviewState = {
        previewId,
        pluginId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        digest,
        source: resolvedSource.source,
        signature: {
          status:
            resolvedSource.source.kind === 'local'
              ? 'local_user_source'
              : 'unverified',
          publisher: null,
        },
        capabilities: manifestCapabilities(manifest),
        fileCount: tree.fileCount,
        totalBytes: tree.totalBytes,
        payloadRoot,
        manifest,
      }
      this.previews.set(previewId, preview)
      return publicPreview(preview)
    } catch (error) {
      rmSync(previewRoot, { recursive: true, force: true })
      throw error
    }
  }

  private async resolveInspectionSource(
    source: PluginInstallSource,
    previewRoot: string,
  ): Promise<{ root: string; source: PluginSource }> {
    if (source.kind === 'local') {
      const root = resolve(source.path)
      assertRegularDirectory(root, 'Plugin source')
      return { root, source: { kind: 'local', label: basename(root) } }
    }
    if (!this.webFetchClient)
      throw new Error(
        'URL Plugin inspection requires a trusted host fetch capability',
      )
    const response = await this.webFetchClient.get({
      url: source.url,
      protocols: ['https:'],
      maxBytes: MAX_PLUGIN_TOTAL_BYTES,
      signal: AbortSignal.timeout(60_000),
      redirectMode: 'follow_validated',
      headers: {
        accept: 'application/zip, application/octet-stream',
        'user-agent': 'Emperor-Agent-Plugin/1',
      },
    })
    if (isPublicHttpRedirectResponse(response))
      throw new Error('Plugin download returned an unresolved redirect')
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Plugin download failed with HTTP ${response.status}`)
    const archive = join(previewRoot, 'source.zip')
    writeFileSync(archive, response.body, { mode: 0o600 })
    const extracted = join(previewRoot, 'extracted')
    extractBoundedZip({
      archive,
      destination: extracted,
      maxArchiveBytes: MAX_PLUGIN_TOTAL_BYTES,
      maxFiles: MAX_PLUGIN_FILES,
      maxFileBytes: MAX_PLUGIN_FILE_BYTES,
      maxTotalBytes: MAX_PLUGIN_TOTAL_BYTES,
      maxPathDepth: 32,
    })
    return {
      root: findSinglePluginRoot(extracted),
      source: { kind: 'url', url: response.url },
    }
  }

  async install(input: ConfirmedPluginInstall): Promise<PluginOperationResult> {
    const preview = this.previews.get(String(input.previewId ?? ''))
    if (!preview) throw new Error('Plugin preview is missing or expired')
    if (preview.digest !== String(input.digest ?? '').toLowerCase())
      throw new Error('Plugin preview digest mismatch')
    if (!isPluginScope(input.scope) || input.scope === 'managed')
      throw new Error('Plugin install scope is not user-mutable')
    const currentDigest = digestTree(preview.payloadRoot)
    if (currentDigest !== preview.digest)
      throw new Error('Plugin preview content changed after inspection')
    validateManifestPaths(preview.payloadRoot, preview.manifest)
    const cachePath = this.cachePath(preview)
    mkdirPrivate(dirname(cachePath))
    if (existsSync(cachePath)) {
      if (digestTree(cachePath) !== preview.digest)
        throw new Error('Plugin cache digest collision')
      rmSync(preview.payloadRoot, { recursive: true, force: true })
    } else {
      renameSync(preview.payloadRoot, cachePath)
    }
    const timestamp = this.now().toISOString()
    const entry: InstalledPluginEntry = {
      pluginId: preview.pluginId,
      scope: input.scope,
      version: preview.version,
      digest: preview.digest,
      installPath: cachePath,
      source: preview.source,
      signature: preview.signature,
      installedAt:
        this.store.get(preview.pluginId, input.scope)?.installedAt ?? timestamp,
      updatedAt: timestamp,
    }
    this.store.upsert(entry)
    this.writeIntent(input.scope, preview.pluginId, true)
    this.previews.delete(preview.previewId)
    rmSync(join(this.stagingRoot, preview.previewId), {
      recursive: true,
      force: true,
    })
    this.onChanged()
    return {
      changed: true,
      plugin: this.summary(preview.pluginId, input.scope),
    }
  }

  setEnabled(
    input: PluginScopeTarget & { enabled: boolean },
  ): PluginOperationResult {
    const pluginId = assertPluginId(input.pluginId)
    this.assertMutableScope(input.scope)
    const before = this.readIntent(input.scope)[pluginId] === true
    this.writeIntent(input.scope, pluginId, input.enabled)
    this.onChanged()
    return {
      changed: before !== input.enabled,
      plugin: this.summary(pluginId, input.scope),
    }
  }

  uninstall(input: PluginScopeTarget): PluginOperationResult {
    const pluginId = assertPluginId(input.pluginId)
    this.assertMutableScope(input.scope)
    const changed = this.store.remove(pluginId, input.scope)
    this.writeIntent(input.scope, pluginId, false)
    this.onChanged()
    return { changed, plugin: this.summary(pluginId, input.scope) }
  }

  enabledSkillRoots(): string[] {
    return this.list().flatMap((summary) => {
      if (summary.activation !== 'active') return []
      const entry = this.store.get(summary.pluginId, summary.scope)
      if (!entry) return []
      const manifest = readManifest(entry.installPath)
      return (manifest.skills ?? []).map((path) =>
        resolveContainedManifestPath(entry.installPath, path),
      )
    })
  }

  private summary(pluginId: string, scope: PluginScope): PluginSummary {
    const entry = this.store.get(pluginId, scope)
    const enabled = this.readIntent(scope)[pluginId] === true
    const manifest = entry ? tryReadManifest(entry.installPath) : null
    const signature = pluginEntrySignature(entry)
    const materialization = entry && manifest ? 'installed' : 'missing'
    const activation = !enabled
      ? 'disabled'
      : materialization === 'missing'
        ? 'missing'
        : signature.status === 'unverified'
          ? 'blocked_unverified'
          : 'active'
    const capabilities = manifestCapabilities(manifest)
    return {
      pluginId,
      name: manifest?.name ?? pluginId.split('/').at(-1) ?? pluginId,
      scope,
      version: entry?.version ?? '',
      digest: entry?.digest ?? '',
      source: entry?.source ?? {
        kind: 'marketplace',
        marketplace: 'unresolved',
      },
      signature,
      enabled,
      materialization,
      activation,
      capabilities: {
        skills: capabilities.skills.length,
        agents: capabilities.agents.length,
        hooks: capabilities.hooks.length,
        mcpServers: capabilities.mcpServers.length,
        lspServers: capabilities.lspServers.length,
        commands: capabilities.commands.length,
      },
    }
  }

  private cachePath(preview: PluginInstallPreview): string {
    const segments = preview.pluginId.split('/')
    const version = String(preview.version).trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version))
      throw new Error('invalid Plugin version')
    return join(this.cacheRoot, ...segments, version, preview.digest)
  }

  private assertMutableScope(scope: PluginScope): void {
    if (!isPluginScope(scope) || scope === 'managed')
      throw new Error('managed Plugin scope is read-only')
    if (
      (scope === 'project' || scope === 'local') &&
      !this.activeWorkspaceRoot()
    )
      throw new Error('Plugin project scope requires an active workspace')
  }

  private settingsPath(scope: PluginScope): string {
    if (scope === 'user') return join(this.emperorHome, 'settings.json')
    const workspace = this.activeWorkspaceRoot()
    if (!workspace) return ''
    return join(
      resolve(workspace),
      '.emperor',
      scope === 'local' ? 'settings.local.json' : 'settings.json',
    )
  }

  private readIntent(scope: PluginScope): Record<string, boolean> {
    const path = this.settingsPath(scope)
    if (!path || !existsSync(path)) return {}
    let raw: Record<string, unknown>
    try {
      raw = readJsonObject(path)
    } catch {
      // This bootstrap read must not mutate or quarantine configuration. The
      // owning config service performs recovery and reports the corruption.
      return {}
    }
    const enabled = raw.enabledPlugins
    if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled))
      return {}
    return Object.fromEntries(
      Object.entries(enabled as Record<string, unknown>)
        .filter(([id, value]) => {
          try {
            assertPluginId(id)
            return typeof value === 'boolean'
          } catch {
            return false
          }
        })
        .map(([id, value]) => [id, value === true]),
    )
  }

  private writeIntent(
    scope: PluginScope,
    pluginId: string,
    enabled: boolean,
  ): void {
    this.assertMutableScope(scope)
    const path = this.settingsPath(scope)
    const settings = existsSync(path) ? readJsonObject(path) : {}
    const current =
      settings.enabledPlugins &&
      typeof settings.enabledPlugins === 'object' &&
      !Array.isArray(settings.enabledPlugins)
        ? { ...(settings.enabledPlugins as Record<string, unknown>) }
        : {}
    current[pluginId] = enabled
    settings.enabledPlugins = current
    writePrivateJsonAtomic(path, settings)
  }
}

function readManifest(root: string): PluginManifestV1 {
  const manifestPath = resolveContainedManifestPath(root, MANIFEST_PATH)
  const raw = readJsonObject(manifestPath)
  if (Number(raw.schemaVersion) !== 1) throw new Error('invalid Plugin schema')
  const id = assertPluginId(String(raw.id ?? ''))
  const name = String(raw.name ?? '').trim()
  const version = String(raw.version ?? '').trim()
  if (!name || !version) throw new Error('Plugin name and version are required')
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    ...(typeof raw.description === 'string'
      ? { description: raw.description }
      : {}),
    ...manifestPathLists(raw),
    ...(typeof raw.dataRoot === 'string' ? { dataRoot: raw.dataRoot } : {}),
  }
}

function tryReadManifest(root: string): PluginManifestV1 | null {
  try {
    return readManifest(root)
  } catch {
    return null
  }
}

function pluginEntrySignature(entry: InstalledPluginEntry | null) {
  if (entry?.signature) return { ...entry.signature }
  if (entry?.source.kind === 'local')
    return { status: 'local_user_source' as const, publisher: null }
  return { status: 'unverified' as const, publisher: null }
}

function manifestPathLists(raw: Record<string, unknown>) {
  const list = (key: string): string[] => {
    const value = raw[key]
    if (value === undefined) return []
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === 'string')
    )
      throw new Error(`Plugin ${key} must be a relative path list`)
    return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
  }
  return {
    skills: list('skills'),
    agents: list('agents'),
    hooks: list('hooks'),
    mcpServers: list('mcpServers'),
    lspServers: list('lspServers'),
    commands: list('commands'),
  }
}

function validateManifestPaths(root: string, manifest: PluginManifestV1): void {
  for (const path of [
    ...(manifest.skills ?? []),
    ...(manifest.agents ?? []),
    ...(manifest.hooks ?? []),
    ...(manifest.mcpServers ?? []),
    ...(manifest.lspServers ?? []),
    ...(manifest.commands ?? []),
    ...(manifest.dataRoot ? [manifest.dataRoot] : []),
  ]) {
    const resolved = resolveContainedManifestPath(root, path)
    if (!existsSync(resolved))
      throw new Error(`Plugin manifest path is missing: ${path}`)
  }
}

function resolveContainedManifestPath(root: string, path: string): string {
  const clean = String(path ?? '').trim()
  if (!clean || isAbsolute(clean) || clean.includes('\0'))
    throw new Error('Plugin manifest requires a contained relative path')
  const target = resolve(root, clean)
  if (
    !isPathWithin(target, root) ||
    !isPathWithin(
      canonicalizeExistingPath(target),
      canonicalizeExistingPath(root),
    )
  )
    throw new Error('Plugin manifest containment violation')
  return target
}

function inspectTree(root: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0
  let totalBytes = 0
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink())
        throw new Error('Plugin source cannot contain symlinks')
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        fileCount += 1
        totalBytes += stat.size
        if (stat.size > MAX_PLUGIN_FILE_BYTES)
          throw new Error('Plugin file exceeds size limit')
        if (fileCount > MAX_PLUGIN_FILES || totalBytes > MAX_PLUGIN_TOTAL_BYTES)
          throw new Error('Plugin source exceeds bounded extraction limits')
      } else throw new Error('Plugin source contains an unsupported file type')
    }
  }
  visit(root)
  return { fileCount, totalBytes }
}

function findSinglePluginRoot(extractedRoot: string): string {
  const roots: string[] = []
  const visit = (dir: string, depth: number): void => {
    if (depth > 16) throw new Error('Plugin archive nesting exceeds limit')
    const manifest = join(dir, MANIFEST_PATH)
    if (existsSync(manifest)) roots.push(dir)
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (path === join(dir, '.emperor-plugin')) continue
      const stat = lstatSync(path)
      if (stat.isSymbolicLink())
        throw new Error('Plugin archive cannot contain symlinks')
      if (stat.isDirectory()) visit(path, depth + 1)
    }
  }
  visit(extractedRoot, 0)
  if (roots.length !== 1)
    throw new Error(
      roots.length
        ? 'Plugin archive contains multiple manifests'
        : 'Plugin archive is missing .emperor-plugin/plugin.json',
    )
  return roots[0]!
}

function digestTree(root: string): string {
  const hash = createHash('sha256')
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const relativePath = relative(root, path).split(sep).join('/')
      if (stat.isSymbolicLink())
        throw new Error('Plugin tree cannot contain symlinks')
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        hash.update(relativePath)
        hash.update('\0')
        hash.update(readFileSync(path))
        hash.update('\0')
      } else throw new Error('Plugin tree contains an unsupported file type')
    }
  }
  visit(root)
  return hash.digest('hex')
}

function manifestCapabilities(manifest: PluginManifestV1 | null) {
  return {
    skills: [...(manifest?.skills ?? [])],
    agents: [...(manifest?.agents ?? [])],
    hooks: [...(manifest?.hooks ?? [])],
    mcpServers: [...(manifest?.mcpServers ?? [])],
    lspServers: [...(manifest?.lspServers ?? [])],
    commands: [...(manifest?.commands ?? [])],
  }
}

function publicPreview(preview: PreviewState): PluginInstallPreview {
  const { payloadRoot: _payloadRoot, manifest: _manifest, ...value } = preview
  return structuredClone(value)
}

function assertRegularDirectory(path: string, label: string): void {
  if (!existsSync(path) || !lstatSync(path).isDirectory())
    throw new Error(`${label} must be a regular directory`)
}

function readJsonObject(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`invalid JSON object: ${path}`)
  return value as Record<string, unknown>
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  mkdirPrivate(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
}
