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

export interface InstalledPluginEntry {
  readonly pluginId: string
  readonly scope: PluginScope
  readonly version: string
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
  readonly version: string
  readonly digest: string
  readonly source: PluginSource
  readonly signature: PluginSignature
  readonly enabled: boolean
  readonly materialization: 'installed' | 'missing'
  readonly activation: 'active' | 'disabled' | 'missing' | 'blocked_unverified'
  readonly capabilities: {
    readonly skills: number
    readonly agents: number
    readonly hooks: number
    readonly mcpServers: number
    readonly lspServers: number
    readonly commands: number
  }
}

export type PluginInstallSource =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }

export interface PluginInstallPreview {
  readonly previewId: string
  readonly pluginId: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly digest: string
  readonly source: PluginSource
  readonly signature: PluginSignature
  readonly capabilities: {
    readonly skills: readonly string[]
    readonly agents: readonly string[]
    readonly hooks: readonly string[]
    readonly mcpServers: readonly string[]
    readonly lspServers: readonly string[]
    readonly commands: readonly string[]
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
