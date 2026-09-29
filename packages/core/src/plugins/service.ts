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
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { extractBoundedZip } from '../environment/zip'
import { isPublicHttpRedirectResponse } from '../network/public-http'
import type { WebFetchClient } from '../network/web-fetch-client'
import { EmperorError } from '../errors'
import {
  NO_PLUGIN_RUNTIME,
  PLUGIN_SCOPE_PRECEDENCE,
  pathScrubber,
  pluginComponentViews,
  pluginPermissions,
  type PluginPackageVerdict,
} from './detail'
import { PluginPackageError } from './errors'
import {
  findPluginPackageRoot,
  pluginVersionSegment,
  resolvePluginPackage,
} from './manifest-resolver'
import {
  assertPluginId,
  isPluginScope,
  type ConfirmedPluginInstall,
  type InstalledPluginEntry,
  type PluginInstallPreview,
  type PluginDetail,
  type PluginInstallSource,
  type PluginOperationResult,
  type PluginRuntimeView,
  type PluginScope,
  type PluginScopeTarget,
  type PluginSource,
  type PluginSummary,
  type ResolvedPluginPackage,
} from './models'
import { PluginStore } from './store'

const MAX_PLUGIN_FILES = 4_000
const MAX_PLUGIN_FILE_BYTES = 20 * 1024 * 1024
const MAX_PLUGIN_TOTAL_BYTES = 200 * 1024 * 1024
const PREVIEW_ID = /^plugin_preview_[a-f0-9]{24}$/
/** Previews live only in memory; their folders outlive a restart. */
const STALE_PREVIEW_MS = 24 * 60 * 60 * 1000

interface PreviewState extends PluginInstallPreview {
  readonly payloadRoot: string
}

export interface PluginApplicationServiceOptions {
  readonly emperorHome: string
  readonly activeWorkspaceRoot?: (() => string | null) | null
  readonly onChanged?: (() => void) | null
  readonly now?: () => Date
  readonly idFactory?: () => string
  readonly webFetchClient?: WebFetchClient | null
  /** Live MCP and Skill facts for member states; defaults to none. */
  readonly runtime?: PluginRuntimeView | null
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
  private readonly runtime: PluginRuntimeView
  private readonly previews = new Map<string, PreviewState>()
  /** Installed caches are content-addressed, so a resolution is reusable per path and digest. */
  private readonly resolutions = new Map<string, ResolvedPluginPackage | null>()

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
    this.runtime = opts.runtime ?? NO_PLUGIN_RUNTIME
    mkdirPrivate(this.stagingRoot)
    mkdirPrivate(this.cacheRoot)
    mkdirPrivate(join(this.pluginsRoot, 'data'))
    this.store.ensure()
    this.removeStalePreviews()
  }

  /** Installed packages as the active session's project sees them. */
  list(): PluginSummary[] {
    return this.summariesFor(this.activeWorkspaceRoot())
  }

  /** Everything the detail page shows (contract §6.2); throws `plugin_not_found`. */
  detail(input: PluginScopeTarget): PluginDetail {
    const pluginId = assertPluginId(input.pluginId)
    const workspace = this.activeWorkspaceRoot()
    const summaries = this.summariesFor(workspace)
    const summary = summaries.find(
      (item) => item.pluginId === pluginId && item.scope === input.scope,
    )
    if (!summary) throw new EmperorError('找不到这个插件', 'plugin_not_found')
    const entry = this.store.get(pluginId, input.scope)
    const resolved = entry ? this.resolveInstalled(entry) : null
    const verdict = verdictOf(summary, summaries)
    const scrub = resolved
      ? pathScrubber(resolved.rootPath)
      : (text: string) => text
    return {
      pluginId,
      scope: input.scope,
      format: summary.format,
      version: summary.version,
      displayName: summary.displayName,
      description: summary.description,
      longDescription: resolved?.longDescription ?? null,
      developerName: summary.developerName,
      category: resolved?.category ?? null,
      homepage: resolved?.homepage ?? null,
      license: resolved?.license ?? null,
      logo: summary.logo,
      logoIssue: resolved?.logoIssue ? scrub(resolved.logoIssue) : null,
      prompts: [...(resolved?.prompts ?? [])],
      enabled: summary.enabled,
      effective: summary.effective,
      activation: summary.activation,
      materialization: summary.materialization,
      toggleable: summary.toggleable,
      uninstallable: summary.uninstallable,
      source: summary.source,
      signature: summary.signature,
      digest: summary.digest || null,
      installedAt: entry?.installedAt ?? null,
      permissions: pluginPermissions(resolved),
      components: pluginComponentViews({
        pluginId,
        scope: input.scope,
        resolved,
        verdict,
        projectRoot: workspace,
        runtime: this.runtime,
      }),
    }
  }

  /** Every registered package for one workspace, with the scope in effect marked. */
  private summariesFor(workspace: string | null): PluginSummary[] {
    const base = this.store
      .list()
      .map((entry) => this.baseSummary(entry.pluginId, entry.scope, workspace))
    const winners = new Map<string, PluginScope>()
    for (const scope of PLUGIN_SCOPE_PRECEDENCE)
      for (const summary of base)
        if (
          summary.scope === scope &&
          summary.activation === 'active' &&
          !winners.has(summary.pluginId)
        )
          winners.set(summary.pluginId, scope)
    return base
      .map((summary) => ({
        ...summary,
        effective: winners.get(summary.pluginId) === summary.scope,
      }))
      .sort((left, right) =>
        `${left.pluginId}:${left.scope}`.localeCompare(
          `${right.pluginId}:${right.scope}`,
        ),
      )
  }

  /** The result row of a mutation, including a package that is no longer registered. */
  private summaryOf(pluginId: string, scope: PluginScope): PluginSummary {
    const workspace = this.activeWorkspaceRoot()
    return (
      this.summariesFor(workspace).find(
        (item) => item.pluginId === pluginId && item.scope === scope,
      ) ?? this.baseSummary(pluginId, scope, workspace)
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
      const packageRoot = findPluginPackageRoot(resolvedSource.root)
      const tree = inspectTree(packageRoot)
      cpSync(packageRoot, payloadRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
      })
      const resolved = resolvePluginPackage(payloadRoot, { strict: true })
      const digest = digestTree(payloadRoot)
      const preview: PreviewState = {
        previewId,
        pluginId: resolved.pluginId,
        format: resolved.format,
        name: resolved.displayName,
        version: resolved.version,
        description: resolved.description ?? '',
        digest,
        source: resolvedSource.source,
        signature: {
          status:
            resolvedSource.source.kind === 'local'
              ? 'local_user_source'
              : 'unverified',
          publisher: null,
        },
        capabilities: memberIds(resolved),
        fileCount: tree.fileCount,
        totalBytes: tree.totalBytes,
        payloadRoot,
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
      // A local .zip is extracted like a downloaded archive (local install from a file).
      if (
        existsSync(root) &&
        lstatSync(root).isFile() &&
        root.toLowerCase().endsWith('.zip')
      )
        return {
          root: extractPluginArchive(root, previewRoot),
          source: { kind: 'local', label: basename(root) },
        }
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
    return {
      root: extractPluginArchive(archive, previewRoot),
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
    // Checked before anything is written: a refused scope leaves no registry row.
    this.assertMutableScope(input.scope)
    const currentDigest = digestTree(preview.payloadRoot)
    if (currentDigest !== preview.digest)
      throw new Error('Plugin preview content changed after inspection')
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
      plugin: this.summaryOf(preview.pluginId, input.scope),
    }
  }

  setEnabled(
    input: PluginScopeTarget & { enabled: boolean },
  ): PluginOperationResult {
    const pluginId = assertPluginId(input.pluginId)
    this.assertMutableScope(input.scope)
    const workspace = this.activeWorkspaceRoot()
    const before = this.readIntent(input.scope, workspace)[pluginId] === true
    this.writeIntent(input.scope, pluginId, input.enabled)
    this.onChanged()
    return {
      changed: before !== input.enabled,
      plugin: this.summaryOf(pluginId, input.scope),
    }
  }

  /** Remove the registration and its intent; the immutable cache stays. */
  uninstall(input: PluginScopeTarget): PluginOperationResult {
    const pluginId = assertPluginId(input.pluginId)
    this.assertMutableScope(input.scope)
    const changed = this.store.remove(pluginId, input.scope)
    this.deleteIntent(input.scope, pluginId)
    this.onChanged()
    return { changed, plugin: this.summaryOf(pluginId, input.scope) }
  }

  /**
   * Skill folders of the packages in effect for one project (`null` = chat),
   * so project-scoped plugins never leak into chat or other projects.
   */
  enabledSkillRoots(
    projectRoot: string | null = this.activeWorkspaceRoot(),
  ): string[] {
    return this.summariesFor(projectRoot).flatMap((summary) => {
      if (!summary.effective) return []
      const entry = this.store.get(summary.pluginId, summary.scope)
      return entry ? [...(this.resolveInstalled(entry)?.skillRoots ?? [])] : []
    })
  }

  /** The installed package, resolved leniently; `null` when its cache or manifest is gone. */
  private resolveInstalled(
    entry: InstalledPluginEntry,
  ): ResolvedPluginPackage | null {
    const key = `${entry.installPath}\0${entry.digest}`
    const cached = this.resolutions.get(key)
    if (cached && existsSync(cached.manifestPath)) return cached
    let resolved: ResolvedPluginPackage | null
    try {
      resolved = resolvePluginPackage(entry.installPath, { strict: false })
    } catch {
      resolved = null
    }
    if (resolved) this.resolutions.set(key, resolved)
    else this.resolutions.delete(key)
    return resolved
  }

  private baseSummary(
    pluginId: string,
    scope: PluginScope,
    workspace: string | null,
  ): PluginSummary {
    const entry = this.store.get(pluginId, scope)
    const enabled = this.readIntent(scope, workspace)[pluginId] === true
    const resolved = entry ? this.resolveInstalled(entry) : null
    const signature = pluginEntrySignature(entry)
    const materialization = entry && resolved ? 'installed' : 'missing'
    // Contract §2: missing content outranks the intent, then the signature gate.
    const activation =
      materialization === 'missing'
        ? 'missing'
        : !enabled
          ? 'disabled'
          : signature.status === 'unverified'
            ? 'blocked_unverified'
            : 'active'
    const members = memberIds(resolved)
    const displayName =
      resolved?.displayName ?? pluginId.split('/').at(-1) ?? pluginId
    return {
      pluginId,
      name: displayName,
      displayName,
      description: resolved?.description ?? null,
      developerName: resolved?.developerName ?? null,
      format: resolved?.format ?? null,
      logo: null,
      scope,
      version: entry?.version ?? null,
      digest: entry?.digest ?? '',
      source: entry?.source ?? {
        kind: 'marketplace',
        marketplace: 'unresolved',
      },
      signature,
      enabled,
      materialization,
      activation,
      effective: false,
      toggleable: true,
      uninstallable: scope !== 'managed',
      capabilities: {
        skills: members.skills.length,
        agents: members.agents.length,
        hooks: members.hooks.length,
        mcpServers: members.mcpServers.length,
        lspServers: members.lspServers.length,
        commands: members.commands.length,
        apps: members.apps.length,
      },
    }
  }

  private cachePath(preview: PluginInstallPreview): string {
    return join(
      this.cacheRoot,
      ...preview.pluginId.split('/'),
      pluginVersionSegment(preview.version),
      preview.digest,
    )
  }

  private removeStalePreviews(): void {
    const cutoff = this.now().getTime() - STALE_PREVIEW_MS
    let names: string[]
    try {
      names = readdirSync(this.stagingRoot)
    } catch {
      return
    }
    for (const name of names) {
      if (!PREVIEW_ID.test(name)) continue
      const path = join(this.stagingRoot, name)
      try {
        if (lstatSync(path).mtimeMs < cutoff)
          rmSync(path, { recursive: true, force: true })
      } catch {
        // Another process may be removing it; the next start retries.
      }
    }
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

  private settingsPath(
    scope: PluginScope,
    workspace: string | null = this.activeWorkspaceRoot(),
  ): string {
    if (scope === 'user') return join(this.emperorHome, 'settings.json')
    if (!workspace) return ''
    return join(
      resolve(workspace),
      '.emperor',
      scope === 'local' ? 'settings.local.json' : 'settings.json',
    )
  }

  private readIntent(
    scope: PluginScope,
    workspace: string | null,
  ): Record<string, boolean> {
    const path = this.settingsPath(scope, workspace)
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

  /** Drop the intent key so an uninstalled package leaves no row behind. */
  private deleteIntent(scope: PluginScope, pluginId: string): void {
    const path = this.settingsPath(scope)
    if (!path || !existsSync(path)) return
    const settings = readJsonObject(path)
    const current = settings.enabledPlugins
    if (
      !current ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !(pluginId in current)
    )
      return
    const next = { ...(current as Record<string, unknown>) }
    delete next[pluginId]
    settings.enabledPlugins = next
    writePrivateJsonAtomic(path, settings)
  }
}

function verdictOf(
  summary: PluginSummary,
  all: readonly PluginSummary[],
): PluginPackageVerdict {
  if (summary.activation === 'missing') return { kind: 'missing' }
  if (summary.activation === 'disabled') return { kind: 'disabled' }
  if (summary.activation === 'blocked_unverified')
    return { kind: 'blocked_unverified' }
  if (!summary.effective) {
    const winner = all.find(
      (item) => item.pluginId === summary.pluginId && item.effective,
    )
    return { kind: 'shadowed', by: winner?.scope ?? summary.scope }
  }
  return { kind: 'active' }
}

function pluginEntrySignature(entry: InstalledPluginEntry | null) {
  if (entry?.signature) return { ...entry.signature }
  if (entry?.source.kind === 'local')
    return { status: 'local_user_source' as const, publisher: null }
  return { status: 'unverified' as const, publisher: null }
}

function inspectTree(root: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0
  let totalBytes = 0
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const label = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink())
        throw new PluginPackageError(
          'path_unsafe',
          `插件包里不能有符号链接：${label}`,
        )
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        fileCount += 1
        totalBytes += stat.size
        if (stat.size > MAX_PLUGIN_FILE_BYTES)
          throw new PluginPackageError('too_large', `文件 ${label} 超过 20 MiB`)
        if (fileCount > MAX_PLUGIN_FILES || totalBytes > MAX_PLUGIN_TOTAL_BYTES)
          throw new PluginPackageError(
            'too_large',
            '插件包超过 4000 个文件或 200 MiB',
          )
      } else
        throw new PluginPackageError(
          'path_unsafe',
          `插件包里有不支持的文件类型：${label}`,
        )
    }
  }
  visit(root)
  return { fileCount, totalBytes }
}

/** Extract a Plugin archive into the preview folder; the caller locates the package root. */
function extractPluginArchive(archive: string, previewRoot: string): string {
  const extracted = join(previewRoot, 'extracted')
  try {
    extractBoundedZip({
      archive,
      destination: extracted,
      maxArchiveBytes: MAX_PLUGIN_TOTAL_BYTES,
      maxFiles: MAX_PLUGIN_FILES,
      maxFileBytes: MAX_PLUGIN_FILE_BYTES,
      maxTotalBytes: MAX_PLUGIN_TOTAL_BYTES,
      maxPathDepth: 32,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/limit exceeded/.test(message))
      throw new PluginPackageError('too_large', `压缩包超过上限：${message}`)
    if (/unsafe/.test(message))
      throw new PluginPackageError(
        'path_unsafe',
        `压缩包里有不安全的条目：${message}`,
      )
    throw new PluginPackageError(
      'archive_invalid',
      `压缩包无法读取：${message}`,
    )
  }
  return extracted
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

/** Member ids per kind; every list is empty for a package that is not there. */
function memberIds(resolved: ResolvedPluginPackage | null) {
  const ids = (kind: string) =>
    (resolved?.components ?? [])
      .filter((component) => component.kind === kind)
      .map((component) => component.id)
  return {
    skills: ids('skill'),
    agents: ids('agent'),
    hooks: ids('hook'),
    mcpServers: ids('mcp'),
    lspServers: ids('lsp'),
    commands: ids('command'),
    apps: ids('app'),
  }
}

function publicPreview(preview: PreviewState): PluginInstallPreview {
  const { payloadRoot: _payloadRoot, ...value } = preview
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
