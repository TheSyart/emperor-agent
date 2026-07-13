import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadMcpConfig, saveMcpConfig, type MCPConfig } from '../../mcp/config'
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

  getMcpConfig(): MCPConfig {
    return loadMcpConfig(this.root)
  }

  async saveMcpConfig(raw: Record<string, unknown>): Promise<MCPConfig> {
    saveMcpConfig(this.root, raw)
    await this.hooks.reloadMcp?.()
    return this.getMcpConfig()
  }

  private userConfigPath(): string {
    return ensureUserProfileFile(this.root, this.templatesDir)
  }
}
