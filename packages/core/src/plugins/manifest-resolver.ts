/**
 * Plugin package resolution (plugin contract §1–§2): find the package root,
 * detect its format, read the manifest(s), and discover every member with a
 * static verdict. Read-only: nothing on disk changes.
 *
 * Formats, in detection order on one root:
 * 1. `portable`: root `plugin.json` carrying an agent-plugins `$schema`.
 *    OpenAI-specific settings come from `extensions.com.openai` when it is an
 *    object, otherwise from `.codex-plugin/plugin.json`, never merged.
 * 2. `codex-compat`: `.codex-plugin/plugin.json` alone.
 * 3. `emperor-v1`: `.emperor-plugin/plugin.json`, read as before, never rewritten.
 *
 * `strict` (install preview) rejects any member error; otherwise (installed
 * packages) a broken member becomes a `failed` member so the rest stay usable.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { scanSkillSource } from '../skills/file-loader'
import { canonicalizeExistingPath, isPathWithin } from '../util/paths'
import { PluginPackageError } from './errors'
import { parsePluginHooks, type PluginHookSource } from './hook-manifest'
import { decodeLegacyMcp, decodePortableMcp } from './mcp-manifest'
import {
  assertPluginId,
  hasControlCharacter,
  isPortablePluginName,
  type PluginComponentKind,
  type PluginFormat,
  type PluginHookSpec,
  type PluginMcpServerSpec,
  type ResolvedPluginComponent,
  type ResolvedPluginPackage,
} from './models'

export const PORTABLE_MANIFEST = 'plugin.json'
export const CODEX_MANIFEST = join('.codex-plugin', 'plugin.json')
export const EMPEROR_MANIFEST = join('.emperor-plugin', 'plugin.json')

const PLUGIN_SCHEMA =
  /^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/plugin\.schema\.json$/
const SUPPORTED_SCHEMA_VERSION = /^1\.\d+\.\d+$/
const MAX_SEARCH_DEPTH = 16
const MAX_SEARCH_DIRECTORIES = 4_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const SEARCH_SKIP = new Set(['.git', 'node_modules'])
const KIND_ORDER: readonly PluginComponentKind[] = [
  'skill',
  'mcp',
  'app',
  'hook',
  'agent',
  'command',
  'lsp',
]

export interface ResolvePluginOptions {
  /** Preview: any member error fails. Installed: member errors become failed members. */
  readonly strict: boolean
}

/**
 * The single package root under `dir`: the shallowest layer holding a
 * manifest wins, and two roots on that layer are an error. Deeper manifests
 * are package content (for example bundled examples).
 */
export function findPluginPackageRoot(dir: string): string {
  const top = resolve(dir)
  let layer = [top]
  let visited = 0
  for (let depth = 0; depth <= MAX_SEARCH_DEPTH && layer.length; depth += 1) {
    const roots = layer.filter((candidate) => detectFormat(candidate) !== null)
    if (roots.length > 1)
      throw new PluginPackageError(
        'multiple_roots',
        `找到多个插件包：${roots.map((root) => relative(top, root) || '.').join('、')}。一次只能安装一个。`,
      )
    if (roots.length === 1) return roots[0]!
    const next: string[] = []
    for (const parent of layer) {
      for (const name of listDirectory(parent)) {
        if (SEARCH_SKIP.has(name)) continue
        const path = join(parent, name)
        if (!isDirectory(path)) continue
        visited += 1
        if (visited > MAX_SEARCH_DIRECTORIES)
          throw new PluginPackageError(
            'too_large',
            '所选位置下的文件夹太多，找不到插件清单。请直接选择插件所在的文件夹。',
          )
        next.push(path)
      }
    }
    layer = next
  }
  throw missingManifest(top)
}

/** Resolve the package at `root` (already located by {@link findPluginPackageRoot}). */
export function resolvePluginPackage(
  root: string,
  options: ResolvePluginOptions,
): ResolvedPluginPackage {
  const packageRoot = resolve(root)
  switch (detectFormat(packageRoot)) {
    case 'portable':
      return resolvePortable(packageRoot, options)
    case 'codex-compat':
      return resolveCodex(packageRoot, options)
    case 'emperor-v1':
      return resolveEmperorV1(packageRoot, options)
    default:
      throw missingManifest(packageRoot)
  }
}

/** Cache-directory segment for a version: unsafe characters become `_`. */
export function pluginVersionSegment(version: string | null): string {
  if (version === null) return 'unversioned'
  let segment = version.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  if (!/^[A-Za-z0-9]/.test(segment)) segment = `v${segment}`.slice(0, 128)
  return segment
}

/**
 * A package-relative member path, contained lexically and after resolving
 * links. Throws `path_unsafe` for escapes and `member_invalid` when missing.
 */
export function resolveMemberPath(
  root: string,
  ref: unknown,
  label: string,
): string {
  if (typeof ref !== 'string' || !ref.trim())
    throw new PluginPackageError(
      'member_invalid',
      `${label} 必须是包内的相对路径`,
    )
  const clean = ref.trim()
  if (isAbsolute(clean) || clean.includes('\0'))
    throw new PluginPackageError(
      'path_unsafe',
      `${label} 必须是包内的相对路径：${clean}`,
    )
  const target = resolve(root, clean)
  if (
    !isPathWithin(target, root) ||
    !isPathWithin(
      canonicalizeExistingPath(target),
      canonicalizeExistingPath(root),
    )
  )
    throw new PluginPackageError(
      'path_unsafe',
      `${label} 越出了插件目录：${clean}`,
    )
  if (!exists(target))
    throw new PluginPackageError('member_invalid', `找不到 ${label}：${clean}`)
  return target
}

// ---------------------------------------------------------------------------
// Formats

function detectFormat(dir: string): PluginFormat | null {
  if (portableSchemaVersion(join(dir, PORTABLE_MANIFEST)) !== null)
    return 'portable'
  if (isFile(join(dir, CODEX_MANIFEST))) return 'codex-compat'
  if (isFile(join(dir, EMPEROR_MANIFEST))) return 'emperor-v1'
  return null
}

/** The schema version of a root `plugin.json`, or `null` when it is not an agent-plugins manifest. */
function portableSchemaVersion(path: string): string | null {
  if (!isFile(path)) return null
  try {
    if (lstatSync(path).size > MAX_MANIFEST_BYTES) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const schema = objectOf(raw)?.$schema
    return typeof schema === 'string'
      ? (PLUGIN_SCHEMA.exec(schema)?.[1] ?? null)
      : null
  } catch {
    return null
  }
}

function missingManifest(dir: string): PluginPackageError {
  if (isFile(join(dir, PORTABLE_MANIFEST)))
    return new PluginPackageError(
      'manifest_invalid',
      'plugin.json 缺少 agent-plugins.org 的 $schema，无法识别为插件清单',
    )
  return new PluginPackageError(
    'manifest_missing',
    '找不到插件清单：需要根目录的 plugin.json、.codex-plugin/plugin.json 或 .emperor-plugin/plugin.json',
  )
}

function resolvePortable(
  root: string,
  options: ResolvePluginOptions,
): ResolvedPluginPackage {
  const manifestPath = join(root, PORTABLE_MANIFEST)
  const manifest = readManifest(manifestPath, 'plugin.json')
  const schemaVersion = PLUGIN_SCHEMA.exec(String(manifest.$schema))?.[1] ?? ''
  if (!SUPPORTED_SCHEMA_VERSION.test(schemaVersion))
    throw new PluginPackageError(
      'schema_unsupported',
      `不支持 plugin.json 的 schema 版本 ${schemaVersion}`,
    )
  const name = portableName(manifest.name, 'plugin.json')
  const extensions = manifest.extensions
  if (extensions !== undefined && !objectOf(extensions))
    throw manifestInvalid('plugin.json 的 extensions 必须是对象')
  const openaiRaw = objectOf(extensions)?.['com.openai']
  if (openaiRaw !== undefined && !objectOf(openaiRaw))
    throw manifestInvalid('plugin.json 的 extensions.com.openai 必须是对象')
  const codexPath = join(root, CODEX_MANIFEST)
  const codex = isFile(codexPath) ? tryReadObject(codexPath) : null
  if (
    codex?.value &&
    typeof codex.value.name === 'string' &&
    codex.value.name !== name
  )
    throw new PluginPackageError(
      'identity_mismatch',
      `plugin.json 的 name「${name}」与 .codex-plugin/plugin.json 的「${codex.value.name}」不一致`,
    )
  let openai: Record<string, unknown> | null = objectOf(openaiRaw)
  let openaiLabel = 'extensions.com.openai'
  let openaiSource = manifestPath
  if (!openai && codex) {
    if (!codex.value)
      throw manifestInvalid(
        `.codex-plugin/plugin.json 无法解析：${codex.error}`,
      )
    openai = codex.value
    openaiLabel = '.codex-plugin/plugin.json'
    openaiSource = codexPath
  }
  const members = new Members(root, options.strict)
  if (isDirectory(join(root, 'skills')))
    members.addSkillSources([{ path: join(root, 'skills'), label: 'skills/' }])
  if (isFile(join(root, 'mcp.json')))
    members.addMcpFile(join(root, 'mcp.json'), 'mcp.json', 'portable')
  members.addAppRefs(openai?.apps, `${openaiLabel} 的 apps`)
  members.addHookRefs(
    openai?.hooks,
    `${openaiLabel} 的 hooks`,
    openaiSource,
    'codex',
  )
  members.addUnsupportedDirectory('agents', 'agent')
  members.addUnsupportedDirectory('commands', 'command')
  return finish({
    pluginId: name,
    format: 'portable',
    strict: options.strict,
    root,
    manifestPath,
    manifest,
    openai,
    members,
    defaultDisplayName: name,
  })
}

function resolveCodex(
  root: string,
  options: ResolvePluginOptions,
): ResolvedPluginPackage {
  const manifestPath = join(root, CODEX_MANIFEST)
  const label = '.codex-plugin/plugin.json'
  const manifest = readManifest(manifestPath, label)
  const name = portableName(manifest.name, label)
  const members = new Members(root, options.strict)
  if (manifest.skills !== undefined)
    members.addSkillRefs(manifest.skills, `${label} 的 skills`)
  else if (isDirectory(join(root, 'skills')))
    members.addSkillSources([{ path: join(root, 'skills'), label: 'skills/' }])
  if (objectOf(manifest.mcpServers))
    members.addInlineMcp(
      manifest.mcpServers,
      `${label} 的 mcpServers`,
      manifestPath,
    )
  else if (manifest.mcpServers !== undefined)
    for (const ref of refList(manifest.mcpServers, `${label} 的 mcpServers`))
      members.guard('mcp', ref, manifestPath, () =>
        members.addMcpFile(
          resolveMemberPath(root, ref, `${label} 的 mcpServers`),
          ref,
          'legacy',
        ),
      )
  else if (isFile(join(root, '.mcp.json')))
    members.addMcpFile(join(root, '.mcp.json'), '.mcp.json', 'legacy')
  if (manifest.apps !== undefined)
    members.addAppRefs(manifest.apps, `${label} 的 apps`)
  else if (isFile(join(root, '.app.json')))
    members.addAppRefs('.app.json', '.app.json')
  members.addHookRefs(
    manifest.hooks,
    `${label} 的 hooks`,
    manifestPath,
    'codex',
  )
  members.addUnsupportedDirectory('agents', 'agent')
  members.addUnsupportedDirectory('commands', 'command')
  return finish({
    pluginId: name,
    format: 'codex-compat',
    strict: options.strict,
    root,
    manifestPath,
    manifest,
    openai: manifest,
    members,
    defaultDisplayName: name,
  })
}

function resolveEmperorV1(
  root: string,
  options: ResolvePluginOptions,
): ResolvedPluginPackage {
  const manifestPath = join(root, EMPEROR_MANIFEST)
  const label = '.emperor-plugin/plugin.json'
  const manifest = readManifest(manifestPath, label)
  if (Number(manifest.schemaVersion) !== 1)
    throw new PluginPackageError(
      'schema_unsupported',
      `不支持 ${label} 的 schemaVersion ${String(manifest.schemaVersion)}`,
    )
  let pluginId: string
  try {
    pluginId = assertPluginId(String(manifest.id ?? ''))
  } catch {
    throw new PluginPackageError(
      'name_invalid',
      `${label} 的 id「${String(manifest.id ?? '')}」不合规`,
    )
  }
  const name = String(manifest.name ?? '').trim()
  if (!name) throw manifestInvalid(`${label} 缺少 name`)
  if (typeof manifest.version !== 'string' || !manifest.version.trim())
    throw manifestInvalid(`${label} 缺少 version`)
  const lists = pathLists(manifest, label)
  const members = new Members(root, options.strict)
  members.addSkillRefs(lists.skills, `${label} 的 skills`)
  for (const ref of lists.mcpServers)
    members.guard('mcp', ref, manifestPath, () =>
      members.addMcpFile(
        resolveMemberPath(root, ref, `${label} 的 mcpServers`),
        ref,
        'legacy',
      ),
    )
  members.addHookRefs(lists.hooks, `${label} 的 hooks`, manifestPath, 'emperor')
  members.addUnsupportedRefs(lists.agents, 'agent', `${label} 的 agents`)
  members.addUnsupportedRefs(lists.commands, 'command', `${label} 的 commands`)
  members.addUnsupportedRefs(lists.lspServers, 'lsp', `${label} 的 lspServers`)
  // dataRoot is not a member; only the preview checks that it exists.
  if (options.strict && manifest.dataRoot !== undefined)
    resolveMemberPath(root, manifest.dataRoot, `${label} 的 dataRoot`)
  return finish({
    pluginId,
    format: 'emperor-v1',
    strict: options.strict,
    root,
    manifestPath,
    manifest,
    openai: null,
    members,
    defaultDisplayName: name,
  })
}

// ---------------------------------------------------------------------------
// Members

class Members {
  readonly components: ResolvedPluginComponent[] = []
  readonly skillRoots: string[] = []
  readonly mcpServers: PluginMcpServerSpec[] = []
  readonly hooks: PluginHookSpec[] = []
  private readonly skillNames = new Set<string>()
  private readonly appNames = new Set<string>()
  private readonly hookCounts = new Map<string, number>()

  constructor(
    readonly root: string,
    readonly strict: boolean,
  ) {}

  /** Run one member's reader; outside strict mode a failure becomes a failed member. */
  guard(
    kind: PluginComponentKind,
    id: string,
    sourcePath: string | null,
    run: () => void,
  ): void {
    try {
      run()
    } catch (error) {
      if (this.strict) throw error
      this.fail(kind, id, sourcePath, messageOf(error))
    }
  }

  addSkillRefs(refs: unknown, label: string): void {
    const sources: Array<{ path: string; label: string }> = []
    for (const ref of refList(refs, label))
      this.guard('skill', ref, null, () => {
        const path = resolveMemberPath(this.root, ref, label)
        if (!isDirectory(path))
          throw new PluginPackageError(
            'member_invalid',
            `${label} 必须指向文件夹：${ref}`,
          )
        sources.push({ path, label: ref })
      })
    this.addSkillSources(sources)
  }

  addSkillSources(
    sources: ReadonlyArray<{ path: string; label: string }>,
  ): void {
    for (const source of sources) {
      this.skillRoots.push(source.path)
      const scan = scanSkillSource({
        kind: 'plugin',
        dir: source.path,
        boundary: this.root,
      })
      for (const skill of scan.skills) {
        if (this.skillNames.has(skill.name)) {
          this.duplicate(
            'skill',
            skill.name,
            skill.skillFile,
            `有两个 Skill 都叫「${skill.name}」`,
          )
          continue
        }
        this.skillNames.add(skill.name)
        this.components.push({
          kind: 'skill',
          id: skill.name,
          title: skill.name,
          description: skill.description,
          sourcePath: skill.skillFile,
          state: 'available',
          reason: null,
        })
      }
      for (const bad of scan.invalid) {
        if (
          bad.errors.some((error) => error.startsWith('Duplicate Skill name'))
        ) {
          this.duplicate(
            'skill',
            bad.name,
            bad.path,
            `有两个 Skill 都叫「${bad.name}」`,
          )
          continue
        }
        this.fail('skill', bad.name, bad.path, bad.reason)
      }
    }
  }

  addMcpFile(
    path: string,
    label: string,
    decoder: 'portable' | 'legacy',
  ): void {
    this.guard('mcp', label, path, () => {
      const raw = readMemberJson(path, label)
      const servers =
        decoder === 'portable'
          ? decodePortableMcp(raw, label)
          : decodeLegacyMcp(raw, label)
      for (const server of servers) this.addMcpServer(server, path)
    })
  }

  addInlineMcp(raw: unknown, label: string, sourcePath: string): void {
    this.guard('mcp', label, sourcePath, () => {
      for (const server of decodeLegacyMcp({ mcpServers: raw }, label))
        this.addMcpServer(server, sourcePath)
    })
  }

  addAppRefs(refs: unknown, label: string): void {
    if (refs === undefined) return
    for (const ref of refList(refs, label))
      this.guard('app', ref, null, () => {
        const path = resolveMemberPath(this.root, ref, label)
        const apps = objectOf(objectOf(readMemberJson(path, ref))?.apps)
        if (!apps)
          throw new PluginPackageError(
            'member_invalid',
            `${ref} 缺少 apps 对象`,
          )
        for (const [name, value] of Object.entries(apps)) {
          if (this.appNames.has(name)) {
            this.duplicate('app', name, path, `有两个应用连接都叫「${name}」`)
            continue
          }
          this.appNames.add(name)
          // Only a title and a description are read; the rest is for its host.
          const entry = objectOf(value)
          this.components.push({
            kind: 'app',
            id: name,
            title: clip(entry?.title, 80) ?? name,
            description: clip(entry?.description, 200) ?? '',
            sourcePath: path,
            state: 'unsupported',
            reason: 'Emperor 还不支持这个应用连接',
          })
        }
      })
  }

  /**
   * Hooks from a manifest field (path, paths, inline object or objects), or
   * the default `hooks/hooks.json` when the field is absent. Parsed after
   * MCP so `mcp__<server>__<tool>` tokens can name this package's servers.
   */
  addHookRefs(
    refs: unknown,
    label: string,
    manifestPath: string,
    dialect: 'emperor' | 'codex',
  ): void {
    const sources: PluginHookSource[] = []
    const entries =
      refs === undefined
        ? isFile(join(this.root, 'hooks', 'hooks.json'))
          ? ['hooks/hooks.json']
          : []
        : Array.isArray(refs)
          ? refs
          : [refs]
    for (const [index, entry] of entries.entries()) {
      const inline = objectOf(entry)
      if (inline) {
        sources.push({
          raw: inline,
          label: `${label}[${index}]`,
          sourcePath: manifestPath,
        })
        continue
      }
      this.guard('hook', String(entry), manifestPath, () => {
        const path = resolveMemberPath(this.root, entry, label)
        sources.push({
          raw: readMemberJson(path, String(entry)),
          label: String(entry),
          sourcePath: path,
        })
      })
    }
    const mcpServers = this.mcpServers.map((server) => server.name)
    for (const source of sources)
      this.guard('hook', source.label, source.sourcePath, () => {
        const parsed = parsePluginHooks(source, {
          dialect,
          mcpServers,
          counts: this.hookCounts,
        })
        this.hooks.push(...parsed.hooks)
        this.components.push(...parsed.components)
      })
  }

  addUnsupportedDirectory(
    directory: 'agents' | 'commands',
    kind: 'agent' | 'command',
  ): void {
    const top = join(this.root, directory)
    if (!isDirectory(top)) return
    for (const path of markdownFiles(top)) {
      const id = relative(this.root, path).split(sep).join('/')
      this.components.push(unsupported(kind, id, path))
    }
  }

  addUnsupportedRefs(
    refs: readonly string[],
    kind: 'agent' | 'command' | 'lsp',
    label: string,
  ): void {
    for (const ref of refs)
      this.guard(kind, ref, null, () => {
        const path = resolveMemberPath(this.root, ref, label)
        this.components.push(unsupported(kind, ref, path))
      })
  }

  private addMcpServer(server: PluginMcpServerSpec, sourcePath: string): void {
    if (this.mcpServers.some((item) => item.name === server.name)) {
      this.duplicate(
        'mcp',
        server.name,
        sourcePath,
        `有两个 MCP server 都叫「${server.name}」`,
      )
      return
    }
    this.mcpServers.push(server)
    this.components.push({
      kind: 'mcp',
      id: server.name,
      title: server.name,
      description: describeServer(server),
      sourcePath,
      state: 'available',
      reason: null,
    })
  }

  private duplicate(
    kind: PluginComponentKind,
    id: string,
    sourcePath: string | null,
    message: string,
  ): void {
    if (this.strict) throw new PluginPackageError('duplicate_member', message)
    this.fail(kind, id, sourcePath, message)
  }

  private fail(
    kind: PluginComponentKind,
    id: string,
    sourcePath: string | null,
    reason: string,
  ): void {
    this.components.push({
      kind,
      id,
      title: id,
      description: '',
      sourcePath,
      state: 'failed',
      reason,
    })
  }
}

function unsupported(
  kind: 'agent' | 'command' | 'lsp',
  id: string,
  sourcePath: string,
): ResolvedPluginComponent {
  const label = { agent: '子代理', command: '命令', lsp: 'LSP' }[kind]
  return {
    kind,
    id,
    title: basename(id).replace(/\.md$/i, ''),
    description: '',
    sourcePath,
    state: 'unsupported',
    reason: `Emperor 不支持插件里的${label}`,
  }
}

/** Transport and program or host only: arguments, headers and paths may carry secrets. */
function describeServer(server: PluginMcpServerSpec): string {
  if (server.transport === 'stdio') {
    const program = (server.command ?? '').trim().split(/\s+/)[0] ?? ''
    return `stdio · ${program.split(/[\\/]/).pop() ?? program}`
  }
  try {
    return `${server.transport} · ${new URL(server.url ?? '').host}`
  } catch {
    return server.transport
  }
}

// ---------------------------------------------------------------------------
// Result

function finish(input: {
  pluginId: string
  format: PluginFormat
  strict: boolean
  root: string
  manifestPath: string
  manifest: Record<string, unknown>
  openai: Record<string, unknown> | null
  members: Members
  defaultDisplayName: string
}): ResolvedPluginPackage {
  const { manifest, members } = input
  const label =
    input.format === 'emperor-v1'
      ? '.emperor-plugin/plugin.json'
      : input.format === 'codex-compat'
        ? '.codex-plugin/plugin.json'
        : 'plugin.json'
  const face = interfaceOf(input.openai?.interface, input.root)
  const author = objectOf(manifest.author)
  return {
    pluginId: input.pluginId,
    format: input.format,
    rootPath: input.root,
    manifestPath: input.manifestPath,
    version: optionalVersion(manifest.version, label),
    displayName: face.displayName ?? clip(input.defaultDisplayName, 80)!,
    description: face.shortDescription ?? clip(manifest.description, 200),
    longDescription: face.longDescription,
    developerName: face.developerName ?? clip(author?.name, 80),
    category: face.category,
    homepage: clip(manifest.homepage, 300),
    license: clip(manifest.license, 80),
    logoPath: face.logoPath,
    logoIssue: face.logoIssue,
    prompts: face.prompts,
    skillRoots: [...members.skillRoots],
    mcpServers: [...members.mcpServers],
    hooks: [...members.hooks],
    envAllowlist: envAllowlist(manifest.env, label, input.strict),
    components: sortComponents(members.components),
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_ENV_NAMES = 64

/**
 * The manifest's `env` (SEC-07): names of variables its hooks may read from
 * Emperor's environment. The preview rejects anything but a list of
 * variable names; an installed package keeps the valid ones.
 */
function envAllowlist(raw: unknown, label: string, strict: boolean): string[] {
  if (raw === undefined) return []
  const list = Array.isArray(raw) ? raw : []
  const names = list.filter(
    (item): item is string => typeof item === 'string' && ENV_NAME.test(item),
  )
  if (
    strict &&
    (!Array.isArray(raw) ||
      names.length !== list.length ||
      list.length > MAX_ENV_NAMES)
  )
    throw manifestInvalid(
      `${label} 的 env 必须是环境变量名的数组（字母、数字、下划线，最多 ${MAX_ENV_NAMES} 个）`,
    )
  return [...new Set(names)].slice(0, MAX_ENV_NAMES)
}

function interfaceOf(
  raw: unknown,
  root: string,
): {
  displayName: string | null
  shortDescription: string | null
  longDescription: string | null
  developerName: string | null
  category: string | null
  prompts: string[]
  logoPath: string | null
  logoIssue: string | null
} {
  const face = objectOf(raw) ?? {}
  const logo = logoOf(face.logo, root)
  return {
    displayName: clip(face.displayName, 80),
    shortDescription: clip(face.shortDescription, 200),
    longDescription: clip(face.longDescription, 2000),
    developerName: clip(face.developerName, 80),
    category: clip(face.category, 40),
    prompts: promptsOf(face.defaultPrompt),
    ...logo,
  }
}

function logoOf(
  raw: unknown,
  root: string,
): { logoPath: string | null; logoIssue: string | null } {
  if (raw === undefined) return { logoPath: null, logoIssue: null }
  if (typeof raw !== 'string' || !/^(?:\.\/)?assets\//.test(raw.trim()))
    return {
      logoPath: null,
      logoIssue: 'Logo 必须是包内 ./assets/ 下的文件',
    }
  try {
    const path = resolveMemberPath(root, raw, 'Logo')
    if (!isFile(path)) return { logoPath: null, logoIssue: 'Logo 必须是文件' }
    return { logoPath: path, logoIssue: null }
  } catch (error) {
    return { logoPath: null, logoIssue: messageOf(error) }
  }
}

function promptsOf(raw: unknown): string[] {
  const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  return values
    .map((value) => clip(value, 500))
    .filter((value): value is string => value !== null)
    .slice(0, 3)
}

function sortComponents(
  components: readonly ResolvedPluginComponent[],
): ResolvedPluginComponent[] {
  const rank = (kind: PluginComponentKind) => KIND_ORDER.indexOf(kind)
  return components
    .map((component, index) => ({ component, index }))
    .sort((left, right) => {
      const byKind = rank(left.component.kind) - rank(right.component.kind)
      if (byKind !== 0) return byKind
      // Hooks keep declaration order; everything else sorts by id.
      if (left.component.kind === 'hook') return left.index - right.index
      return left.component.id < right.component.id
        ? -1
        : left.component.id > right.component.id
          ? 1
          : left.index - right.index
    })
    .map(({ component }) => component)
}

// ---------------------------------------------------------------------------
// Manifest fields

function portableName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isPortablePluginName(value))
    throw new PluginPackageError(
      'name_invalid',
      `${label} 的 name「${String(value ?? '')}」不合规：需要 1–64 个小写字母、数字、点或连字符，以字母或数字开头结尾`,
    )
  return value
}

function optionalVersion(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string')
    throw manifestInvalid(`${label} 的 version 必须是字符串`)
  const version = value.trim()
  if (!version) return null
  if (version.length > 128 || hasControlCharacter(version))
    throw manifestInvalid(`${label} 的 version 过长或含控制字符`)
  return version
}

function pathLists(manifest: Record<string, unknown>, label: string) {
  const list = (key: string): string[] => {
    const value = manifest[key]
    if (value === undefined) return []
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === 'string')
    )
      throw manifestInvalid(`${label} 的 ${key} 必须是相对路径数组`)
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

function refList(value: unknown, label: string): string[] {
  const values = Array.isArray(value) ? value : [value]
  if (!values.every((item) => typeof item === 'string'))
    throw new PluginPackageError(
      'member_invalid',
      `${label} 必须是相对路径或其数组`,
    )
  return values as string[]
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text.slice(0, max) : null
}

// ---------------------------------------------------------------------------
// File system

function readManifest(path: string, label: string): Record<string, unknown> {
  if (lstatSync(path).size > MAX_MANIFEST_BYTES)
    throw manifestInvalid(`${label} 太大`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw manifestInvalid(`${label} 无法解析：${messageOf(error)}`)
  }
  const manifest = objectOf(raw)
  if (!manifest) throw manifestInvalid(`${label} 必须是 JSON 对象`)
  return manifest
}

function readMemberJson(path: string, label: string): unknown {
  if (!isFile(path))
    throw new PluginPackageError('member_invalid', `${label} 必须是文件`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new PluginPackageError(
      'member_invalid',
      `${label} 无法解析：${messageOf(error)}`,
    )
  }
}

function tryReadObject(
  path: string,
):
  | { value: Record<string, unknown>; error?: undefined }
  | { value?: undefined; error: string } {
  try {
    const value = objectOf(JSON.parse(readFileSync(path, 'utf8')))
    return value ? { value } : { error: '必须是 JSON 对象' }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

function markdownFiles(dir: string): string[] {
  const files: string[] = []
  const visit = (current: string): void => {
    for (const name of listDirectory(current)) {
      const path = join(current, name)
      if (isDirectory(path)) visit(path)
      else if (isFile(path) && name.toLowerCase().endsWith('.md'))
        files.push(path)
    }
  }
  visit(dir)
  return files
}

function listDirectory(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function manifestInvalid(message: string): PluginPackageError {
  return new PluginPackageError('manifest_invalid', message)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
