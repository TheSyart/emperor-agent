/**
 * 探索 — the curated catalog (exploreCatalog.json, schema v1, shipped in the
 * page chunk; never fetched at runtime) and its pure helpers: validation,
 * filters, the 已安装 check and the payload each install flow is opened
 * with. Every entry was checked against its public source when it was
 * added; installing still goes through the user-confirmed flows (Skill URL
 * import, Plugin inspect → install, MCP dry-run → import).
 *
 * Schema v1:
 *   { version: 1, entries: [{ id, kind: 'skill' | 'mcp' | 'plugin', name,
 *     publisher, description, homepage, tags,
 *     install: { skillUrl } | { pluginUrl } | { mcpConfig } }] }
 */

export type ExploreKind = 'skill' | 'mcp' | 'plugin'
/** The 能力 tab the 推荐 block is shown on (UI-S08). */
export type RecommendationTab = 'plugins' | 'skills' | 'mcp' | 'tools'

export type ExploreInstall =
  | { skillUrl: string }
  | { pluginUrl: string }
  | { mcpConfig: Record<string, unknown> }

export interface ExploreEntry {
  id: string
  kind: ExploreKind
  name: string
  publisher: string
  description: string
  homepage: string
  tags: string[]
  install: ExploreInstall
}

export interface ExploreCatalog {
  version: 1
  entries: ExploreEntry[]
}

const KINDS = new Set<string>(['skill', 'mcp', 'plugin'])
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
/** Commands an MCP entry may launch (package runners, no shell). */
const MCP_COMMANDS = new Set(['npx', 'uvx'])
const MCP_TRANSPORTS = new Set(['http', 'streamable-http', 'sse'])
const MCP_SERVER_KEYS = new Set(['command', 'args', 'type', 'url'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Hosts an entry must never point at: loopback, private / link-local
 * ranges, `.local` / `.internal` names and bare IPv6 literals.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host.includes(':')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/** Why `value` is not a public https URL without credentials ('' when it is). */
export function publicHttpsIssue(value: unknown): string {
  if (!isText(value)) return 'missing URL'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `invalid URL ${value}`
  }
  if (url.protocol !== 'https:') return `not https: ${value}`
  if (url.username || url.password) return `credentials in ${value}`
  if (isPrivateHost(url.hostname)) return `private host in ${value}`
  return ''
}

/** The server map of an MCP config (`mcpServers` or `servers`). */
export function mcpConfigServers(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const servers = config.mcpServers ?? config.servers
  return isRecord(servers) ? servers : {}
}

function mcpConfigIssues(config: unknown): string[] {
  if (!isRecord(config)) return ['mcpConfig must be an object']
  const servers = Object.entries(mcpConfigServers(config))
  if (!servers.length) return ['mcpConfig has no mcpServers']
  const issues: string[] = []
  for (const [name, server] of servers) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
      issues.push(`bad server name ${name}`)
    if (!isRecord(server)) {
      issues.push(`server ${name} must be an object`)
      continue
    }
    // No env / headers: a curated entry never carries or asks for secrets.
    for (const key of Object.keys(server))
      if (!MCP_SERVER_KEYS.has(key))
        issues.push(`server ${name} has unsupported field ${key}`)
    if (server.url !== undefined || server.type !== undefined) {
      if (!MCP_TRANSPORTS.has(String(server.type)))
        issues.push(`server ${name} has unknown type ${String(server.type)}`)
      const issue = publicHttpsIssue(server.url)
      if (issue) issues.push(`server ${name}: ${issue}`)
      if (server.command !== undefined)
        issues.push(`server ${name} mixes url and command`)
      continue
    }
    if (!MCP_COMMANDS.has(String(server.command)))
      issues.push(`server ${name} runs ${String(server.command)}`)
    if (
      !Array.isArray(server.args) ||
      !server.args.length ||
      !server.args.every(isText)
    )
      issues.push(`server ${name} needs string args`)
  }
  return issues
}

/** Problems of one entry ([] when it is valid). */
export function exploreEntryIssues(entry: unknown): string[] {
  if (!isRecord(entry)) return ['entry must be an object']
  const id = String(entry.id ?? '')
  const at = (issue: string) => `${id || '?'}: ${issue}`
  const issues: string[] = []
  if (!ID_RE.test(id)) issues.push(at('id must be kebab-case'))
  if (!KINDS.has(String(entry.kind))) issues.push(at('unknown kind'))
  for (const key of ['name', 'publisher', 'description'] as const)
    if (!isText(entry[key])) issues.push(at(`missing ${key}`))
  const homepage = publicHttpsIssue(entry.homepage)
  if (homepage) issues.push(at(`homepage ${homepage}`))
  if (!Array.isArray(entry.tags) || !entry.tags.every(isText))
    issues.push(at('tags must be strings'))
  const install = entry.install
  if (!isRecord(install)) return [...issues, at('missing install')]
  const keys = Object.keys(install)
  const expected =
    entry.kind === 'skill'
      ? 'skillUrl'
      : entry.kind === 'plugin'
        ? 'pluginUrl'
        : 'mcpConfig'
  if (keys.length !== 1 || keys[0] !== expected)
    return [...issues, at(`install must be { ${expected} }`)]
  if (expected === 'mcpConfig')
    issues.push(...mcpConfigIssues(install.mcpConfig).map(at))
  else {
    const issue = publicHttpsIssue(install[expected])
    if (issue) issues.push(at(`${expected} ${issue}`))
  }
  return issues
}

/** Catalog-level problems: version, entry shapes, duplicate ids. */
export function exploreCatalogIssues(catalog: unknown): string[] {
  if (!isRecord(catalog)) return ['catalog must be an object']
  const issues: string[] = []
  if (catalog.version !== 1) issues.push('catalog version must be 1')
  if (!Array.isArray(catalog.entries)) return [...issues, 'missing entries']
  const seen = new Set<string>()
  for (const entry of catalog.entries) {
    issues.push(...exploreEntryIssues(entry))
    const id = isRecord(entry) ? String(entry.id ?? '') : ''
    if (seen.has(id)) issues.push(`${id}: duplicate id`)
    seen.add(id)
  }
  return issues
}

/** Valid entries of a catalog (an invalid one is never rendered). */
export function validExploreEntries(catalog: unknown): ExploreEntry[] {
  if (!isRecord(catalog) || catalog.version !== 1) return []
  if (!Array.isArray(catalog.entries)) return []
  const seen = new Set<string>()
  return catalog.entries.filter((entry): entry is ExploreEntry => {
    if (exploreEntryIssues(entry).length) return false
    const id = (entry as ExploreEntry).id
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const RECOMMENDED_MAX = 6
const RECOMMENDED_MIN = 3

/**
 * The 推荐 picks of a 能力 tab (UI-S08, 探索 folded in): Skills and MCP
 * show their own kind, 插件 (the landing tab) the catalog's first picks of
 * any kind, 工具 none. Fewer than three make no block.
 */
export function recommendedEntries(
  entries: readonly ExploreEntry[],
  tab: RecommendationTab,
): ExploreEntry[] {
  const kind: ExploreKind | 'any' | null =
    tab === 'skills'
      ? 'skill'
      : tab === 'mcp'
        ? 'mcp'
        : tab === 'plugins'
          ? 'any'
          : null
  if (kind === null) return []
  const picks = entries
    .filter((entry) => kind === 'any' || entry.kind === kind)
    .slice(0, RECOMMENDED_MAX)
  return picks.length >= RECOMMENDED_MIN ? picks : []
}

/** The Skill folder a GitHub tree link imports (its last path segment). */
export function skillNameFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return decodeURIComponent(parts.at(-1) ?? '')
  } catch {
    return ''
  }
}

/** Server names an MCP entry adds. */
export function mcpEntryServerNames(entry: ExploreEntry): string[] {
  return 'mcpConfig' in entry.install
    ? Object.keys(mcpConfigServers(entry.install.mcpConfig))
    : []
}

/** Pretty JSON for the MCP add dialog's paste tab. */
export function mcpEntryConfigText(entry: ExploreEntry): string {
  return 'mcpConfig' in entry.install
    ? `${JSON.stringify(entry.install.mcpConfig, null, 2)}\n`
    : ''
}

export interface ExploreInstalledState {
  skills: readonly string[]
  mcpServers: readonly string[]
}

/**
 * Whether the entry is already there: a Skill of the same name, or every
 * server of an MCP entry. Plugins are identified only after `plugins.inspect`,
 * so they never read as installed here.
 */
export function exploreEntryInstalled(
  entry: ExploreEntry,
  state: ExploreInstalledState,
): boolean {
  if ('skillUrl' in entry.install)
    return state.skills.includes(skillNameFromUrl(entry.install.skillUrl))
  if ('mcpConfig' in entry.install) {
    const names = mcpEntryServerNames(entry)
    return (
      names.length > 0 && names.every((name) => state.mcpServers.includes(name))
    )
  }
  return false
}
