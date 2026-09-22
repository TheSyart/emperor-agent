import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  loadMcpConfigUnresolved,
  saveMcpConfig,
  type MCPConfig,
} from '../../mcp/config'
import {
  importMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  type McpImportPlan,
} from '../../mcp/manage'
import { ensureUserProfileFile } from '../../sessions/onboarding'
import { applyUserProfileMarkdownPatch } from '../../memory/user-profile'
import { MemoryVersionStore } from '../../memory/versions'

export interface UserConfigPayload {
  path: 'memory/profile/USER.local.md'
  content: string
}

export interface CoreConfigServiceHooks {
  refreshRuntimeContext?: () => void
  reconcileProfileOnboarding?: () => void
  reloadMcp?: () => void | Promise<void>
}

export class CoreConfigService {
  readonly root: string
  readonly templatesDir: string
  private readonly hooks: CoreConfigServiceHooks

  constructor(
    root: string,
    hooks: CoreConfigServiceHooks = {},
    opts: { templatesDir?: string } = {},
  ) {
    this.root = resolve(root)
    this.templatesDir = resolve(
      opts.templatesDir ?? join(this.root, 'templates'),
    )
    this.hooks = hooks
  }

  getUserConfig(): UserConfigPayload {
    const path = this.userConfigPath()
    return {
      path: 'memory/profile/USER.local.md',
      content: readFileSync(path, 'utf8'),
    }
  }

  saveUserConfig(content: string): UserConfigPayload {
    const path = this.userConfigPath()
    const normalized = `${String(content || '').trimEnd()}\n`
    const current = readFileSync(path, 'utf8')
    const memoryDir = join(this.root, 'memory')
    const versions = new MemoryVersionStore(this.root, memoryDir, path)
    const result = applyUserProfileMarkdownPatch(
      normalized,
      {
        targetPath: path,
        currentContent: current,
        versions,
        memoryDir,
      },
      { rationale: 'save_user_config', explicitReplace: true },
    )
    if (result.errors.includes('missing_profile_sections'))
      throw new Error('save_user_config requires at least one ## section')
    if (!result.ok)
      throw new Error(`save_user_config rejected: ${result.errors.join(', ')}`)
    this.hooks.refreshRuntimeContext?.()
    this.hooks.reconcileProfileOnboarding?.()
    return this.getUserConfig()
  }

  async getMcpConfig(): Promise<MCPConfig> {
    return await loadMcpConfigUnresolved(this.root)
  }

  async saveMcpConfig(raw: Record<string, unknown>): Promise<MCPConfig> {
    await saveMcpConfig(this.root, raw)
    await this.hooks.reloadMcp?.()
    return await this.getMcpConfig()
  }

  /** Merge pasted server config by name; reloads MCP only when something was written. */
  async importMcpServers(input: {
    raw: unknown
    overwrite?: boolean | readonly string[]
    dryRun?: boolean
  }): Promise<McpImportPlan & { config: MCPConfig }> {
    const plan = await importMcpServers(this.root, input.raw, {
      ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
      ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    })
    if (!plan.dryRun && (plan.added.length || plan.updated.length))
      await this.hooks.reloadMcp?.()
    return { ...plan, config: await this.getMcpConfig() }
  }

  async setMcpServerEnabled(input: {
    name: string
    enabled: boolean
  }): Promise<{
    name: string
    enabled: boolean
    changed: boolean
    config: MCPConfig
  }> {
    const result = await setMcpServerEnabled(
      this.root,
      input.name,
      input.enabled,
    )
    if (result.changed) await this.hooks.reloadMcp?.()
    return { ...result, config: await this.getMcpConfig() }
  }

  async removeMcpServer(input: {
    name: string
  }): Promise<{ removed: string; config: MCPConfig }> {
    const result = await removeMcpServer(this.root, input.name)
    await this.hooks.reloadMcp?.()
    return { ...result, config: await this.getMcpConfig() }
  }

  private userConfigPath(): string {
    return ensureUserProfileFile(this.root, this.templatesDir)
  }
}
