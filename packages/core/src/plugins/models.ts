export type PluginScope = 'user' | 'project' | 'local' | 'managed'

export type PluginSource =
  | { readonly kind: 'marketplace'; readonly marketplace: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'local'; readonly label: string }

export interface PluginSignature {
  readonly status: 'local_user_source' | 'verified' | 'unverified'
  readonly publisher: string | null
}

export interface PluginManifestV1 {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly skills?: readonly string[]
  readonly agents?: readonly string[]
  readonly hooks?: readonly string[]
  readonly mcpServers?: readonly string[]
  readonly lspServers?: readonly string[]
  readonly commands?: readonly string[]
  readonly dataRoot?: string
}

/** Package formats, in detection order (contract §1.2). */
export type PluginFormat = 'portable' | 'codex-compat' | 'emperor-v1'

export type PluginComponentKind =
  'skill' | 'mcp' | 'app' | 'hook' | 'agent' | 'command' | 'lsp'

export type PluginComponentState =
  | 'available'
  | 'disabled'
  | 'needs_connection'
  | 'unsupported'
  | 'starting'
  | 'running'
  | 'failed'

/** One member as the package declares it; runtime state is layered on top (contract §2). */
export interface ResolvedPluginComponent {
  readonly kind: PluginComponentKind
  readonly id: string
  readonly title: string
  readonly description: string
  /** Absolute path of the declaring file. Core-internal: never sent to the renderer. */
  readonly sourcePath: string | null
  readonly state: 'available' | 'unsupported' | 'failed'
  readonly reason: string | null
}

/** An MCP server as a plugin declares it; `${PLUGIN_ROOT}`-style variables stay unexpanded. */
export interface PluginMcpServerSpec {
  readonly name: string
  readonly transport: 'stdio' | 'http' | 'sse'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
}

/** One hook handler. `mapped` is present only when Emperor can run it (contract §4). */
export interface PluginHookSpec {
  /** Same id as the hook component: `<event>#<n>`. */
  readonly id: string
  readonly dialect: 'emperor' | 'codex'
  readonly event: string
  readonly matcher: string | null
  /** The command as written; variables are expanded at activation. */
  readonly command: string
  readonly timeoutSec?: number
  readonly mapped?: {
    readonly event:
      | 'SessionStart'
      | 'UserPromptSubmit'
      | 'PreToolUse'
      | 'PostToolUse'
      | 'Stop'
      | 'SubagentStart'
      | 'SubagentStop'
    /** Emperor dialect: the matcher as written (claude-code mode). */
    readonly matcher?: string
    /** Codex dialect: the exact Emperor subjects; absent means every subject. */
    readonly subjects?: readonly string[]
    /** Codex dialect: this plugin's MCP tools, named at activation (contract §3). */
    readonly mcpTools?: readonly {
      readonly server: string
      readonly tool: string
    }[]
  }
}

export interface ResolvedPluginPackage {
  readonly pluginId: string
  readonly format: PluginFormat
  readonly rootPath: string
  readonly manifestPath: string
  readonly version: string | null
  readonly displayName: string
  /** Short description (`shortDescription`, else `description`). */
  readonly description: string | null
  readonly longDescription: string | null
  readonly developerName: string | null
  readonly category: string | null
  readonly homepage: string | null
  readonly license: string | null
  /** Absolute path of a logo inside `assets/`; bytes are checked when served. */
  readonly logoPath: string | null
  readonly logoIssue: string | null
  readonly prompts: readonly string[]
  /** Skill source folders, in declaration order. */
  readonly skillRoots: readonly string[]
  readonly mcpServers: readonly PluginMcpServerSpec[]
  readonly hooks: readonly PluginHookSpec[]
  readonly components: readonly ResolvedPluginComponent[]
}

export interface InstalledPluginEntry {
  readonly pluginId: string
  readonly scope: PluginScope
  /** `null` for a package that declares no version. */
  readonly version: string | null
  readonly digest: string
  readonly installPath: string
  readonly source: PluginSource
  readonly signature?: PluginSignature
  readonly installedAt: string
  readonly updatedAt: string
}

export interface InstalledPluginsFileV1 {
  readonly schemaVersion: 1
  readonly plugins: Record<string, InstalledPluginEntry[]>
}

export interface PluginScopeIntent {
  readonly pluginId: string
  readonly scope: PluginScope
  readonly enabled: boolean
}

export interface PluginSummary {
  readonly pluginId: string
  readonly name: string
  readonly scope: PluginScope
  readonly version: string | null
  readonly digest: string
  readonly source: PluginSource
  readonly signature: PluginSignature
  readonly enabled: boolean
  readonly materialization: 'installed' | 'missing'
  readonly activation: 'active' | 'disabled' | 'missing' | 'blocked_unverified'
  /** Real member counts (contract §2). */
  readonly capabilities: {
    readonly skills: number
    readonly agents: number
    readonly hooks: number
    readonly mcpServers: number
    readonly lspServers: number
    readonly commands: number
    readonly apps: number
  }
}

export type PluginInstallSource =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }

export interface PluginInstallPreview {
  readonly previewId: string
  readonly pluginId: string
  readonly format: PluginFormat
  readonly name: string
  readonly version: string | null
  readonly description: string
  readonly digest: string
  readonly source: PluginSource
  readonly signature: PluginSignature
  /** Member ids per kind: Skill names, MCP server names, hook ids, app keys, unsupported paths. */
  readonly capabilities: {
    readonly skills: readonly string[]
    readonly agents: readonly string[]
    readonly hooks: readonly string[]
    readonly mcpServers: readonly string[]
    readonly lspServers: readonly string[]
    readonly commands: readonly string[]
    readonly apps: readonly string[]
  }
  readonly fileCount: number
  readonly totalBytes: number
}

export interface ConfirmedPluginInstall {
  readonly previewId: string
  readonly digest: string
  readonly scope: PluginScope
}

export interface PluginScopeTarget {
  readonly pluginId: string
  readonly scope: PluginScope
}

export interface PluginOperationResult {
  readonly changed: boolean
  readonly plugin: PluginSummary
}

export function isPluginScope(value: unknown): value is PluginScope {
  return (
    value === 'user' ||
    value === 'project' ||
    value === 'local' ||
    value === 'managed'
  )
}

export function assertPluginId(value: string): string {
  const pluginId = String(value ?? '').trim()
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/.test(pluginId))
    throw new Error(`invalid Plugin id: ${pluginId || '<empty>'}`)
  return pluginId
}

/** agent-plugins 1.0.0 `name`: kebab-case, 1–64 characters; a subset of {@link assertPluginId}. */
export function isPortablePluginName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 64 &&
    /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
  )
}

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return true
  }
  return false
}
