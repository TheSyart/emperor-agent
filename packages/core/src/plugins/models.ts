export type PluginScope = 'user' | 'project' | 'local' | 'managed'

export type PluginSource =
  | { readonly kind: 'marketplace'; readonly marketplace: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'local'; readonly label: string }
  /** Ships with Emperor (plugin contract §5). */
  | { readonly kind: 'managed' }

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

export type PluginActivation =
  'active' | 'disabled' | 'missing' | 'blocked_unverified'

export interface PluginSummary {
  readonly pluginId: string
  /** Same as `displayName`; kept for older callers. */
  readonly name: string
  readonly displayName: string
  /** Short description. */
  readonly description: string | null
  readonly developerName: string | null
  /** `null` when the package content is missing. */
  readonly format: PluginFormat | null
  /** Logo address from the host, or `null` for the generated fallback. */
  readonly logo: string | null
  readonly scope: PluginScope
  readonly version: string | null
  readonly digest: string
  readonly source: PluginSource
  readonly signature: PluginSignature
  readonly enabled: boolean
  readonly materialization: 'installed' | 'missing'
  readonly activation: PluginActivation
  /** Whether this scope is the one in effect when several are active (contract §2). */
  readonly effective: boolean
  readonly toggleable: boolean
  readonly uninstallable: boolean
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

export interface PluginComponentView {
  readonly kind: PluginComponentKind
  readonly id: string
  readonly title: string
  readonly description: string
  readonly state: PluginComponentState
  readonly reason: string | null
}

/** One tool a plugin brings, as its detail lists it. */
export interface PluginToolView {
  /** The name the Agent calls it by. */
  readonly name: string
  /** The tool's own description (what the model reads). */
  readonly description: string
  /** JSON Schema of its arguments. */
  readonly parameters: Readonly<Record<string, unknown>>
  /** It only reads (looks, lists or waits). */
  readonly readOnly: boolean
}

/** A plugin's tools under one member: a Computer Use driver, or an MCP server. */
export interface PluginToolGroup {
  /** Computer Use: `ui`, `embedded-browser`, `external-browser` or `desktop`; MCP: the member's id. */
  readonly id: string
  readonly kind: 'computer-use' | 'mcp'
  readonly title: string
  /** Why the group lists no tools now (its server does not run), else `null`. */
  readonly note: string | null
  readonly tools: readonly PluginToolView[]
}

/** The 工具 of a plugin's detail (contract §6.2). */
export interface PluginToolsView {
  /** Why none of them can be used now (电脑操作 is off), else `null`. */
  readonly note: string | null
  readonly groups: readonly PluginToolGroup[]
}

/** `plugins.getDetail`: everything the detail page shows; never an absolute path (contract §6.2). */
export interface PluginDetail {
  readonly pluginId: string
  readonly scope: PluginScope
  readonly format: PluginFormat | null
  readonly version: string | null
  readonly displayName: string
  readonly description: string | null
  readonly longDescription: string | null
  readonly developerName: string | null
  readonly category: string | null
  readonly homepage: string | null
  readonly license: string | null
  readonly logo: string | null
  readonly logoIssue: string | null
  readonly prompts: readonly string[]
  readonly enabled: boolean
  readonly effective: boolean
  readonly activation: PluginActivation
  readonly materialization: 'installed' | 'missing'
  readonly toggleable: boolean
  readonly uninstallable: boolean
  readonly source: PluginSource
  readonly signature: PluginSignature
  readonly digest: string | null
  readonly installedAt: string | null
  readonly permissions: {
    readonly runsCommands: boolean
    readonly network: boolean
  }
  readonly components: readonly PluginComponentView[]
  readonly tools: PluginToolsView
}

/** What a running plugin MCP server reports; the host fills it in (contract §2). */
export interface PluginMcpRuntimeState {
  readonly state:
    | 'connecting'
    | 'ready'
    | 'degraded'
    | 'backoff'
    | 'auth_failed'
    | 'failed'
    | 'stopped'
  readonly toolCount?: number
  readonly lastError?: string | null
  /** Tools skipped because their Emperor name was already taken (contract §3.2). */
  readonly skippedTools?: readonly string[]
  /** Why the server was not started (for example a missing variable). */
  readonly blocked?: string | null
}

/** Live facts the detail view layers onto a package's own verdicts. */
export interface PluginRuntimeView {
  /** `projectRoot`: the project whose instance runs a project-scoped server. */
  mcpServer(
    pluginId: string,
    scope: PluginScope,
    server: string,
    projectRoot?: string | null,
  ): PluginMcpRuntimeState | null
  /**
   * An app member's connection, when Emperor has an adapter for that member
   * of that package; `null` means no adapter, so the member stays unsupported.
   */
  appConnection?(
    pluginId: string,
    scope: PluginScope,
    appId: string,
  ): {
    readonly state:
      'connected' | 'needs_connection' | 'failed' | 'disabled' | 'unsupported'
    readonly reason: string | null
  } | null
  /** The tools one plugin MCP server has registered while it runs (none otherwise). */
  mcpTools?(
    pluginId: string,
    scope: PluginScope,
    server: string,
    projectRoot?: string | null,
  ): readonly PluginToolView[]
  /** Computer Use's GUI tools by family (`ui` and each driver); static, so listed while it is off. */
  computerUseTools?(): ReadonlyArray<{
    readonly family: string
    readonly tools: readonly PluginToolView[]
  }>
  /** The Skills in effect for a project (`null` = chat), by name. */
  effectiveSkills(projectRoot: string | null): ReadonlyMap<
    string,
    {
      readonly source: 'project' | 'user' | 'plugin' | 'builtin'
      readonly skillFile: string
    }
  >
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
