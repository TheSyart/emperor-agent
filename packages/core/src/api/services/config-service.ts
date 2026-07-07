import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadMcpConfig, saveMcpConfig, type MCPConfig } from '../../mcp/config'
import { ensureUserProfileFile } from '../../sessions/onboarding'
import { applyMemoryPatchToFile, memoryContentHash, type MemoryPatchOperation } from '../../memory/patch'
import { MemoryVersionStore } from '../../memory/versions'

export interface UserConfigPayload {
  path: 'memory/profile/USER.local.md'
  content: string
}

export interface CoreConfigServiceHooks {
  refreshRuntimeContext?: () => void
  reloadMcp?: () => void | Promise<void>
}

export class CoreConfigService {
  readonly root: string
  readonly templatesDir: string
  private readonly hooks: CoreConfigServiceHooks

  constructor(root: string, hooks: CoreConfigServiceHooks = {}, opts: { templatesDir?: string } = {}) {
    this.root = resolve(root)
    this.templatesDir = resolve(opts.templatesDir ?? join(this.root, 'templates'))
    this.hooks = hooks
  }

  getUserConfig(): UserConfigPayload {
    const path = this.userConfigPath()
    return { path: 'memory/profile/USER.local.md', content: readFileSync(path, 'utf8') }
  }

  saveUserConfig(content: string): UserConfigPayload {
    const path = this.userConfigPath()
    const normalized = `${String(content || '').trimEnd()}\n`
    const current = readFileSync(path, 'utf8')
    const operations = userProfileSectionReplacementOps(normalized)
    if (!operations.length) throw new Error('save_user_config requires at least one ## section')
    const memoryDir = join(this.root, 'memory')
    const versions = new MemoryVersionStore(this.root, memoryDir, path)
    const result = applyMemoryPatchToFile({
      target: { kind: 'user_profile' },
      baseVersion: versions.nextVersionForPath(path, { target: 'user' }),
      baseHash: memoryContentHash(current),
      operations,
      rationale: 'save_user_config',
    }, {
      targetPath: path,
      versions,
      versionTarget: 'user',
      ledgerPath: join(memoryDir, 'patch-ledger.jsonl'),
      explicitReplace: true,
    })
    if (!result.ok) throw new Error(`save_user_config rejected: ${result.errors.join(', ')}`)
    this.hooks.refreshRuntimeContext?.()
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

function userProfileSectionReplacementOps(markdown: string): MemoryPatchOperation[] {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const ops: MemoryPatchOperation[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '')
    if (!match) continue
    const section = match[1]!.trim()
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+\S/.test(lines[cursor] ?? '')) {
        end = cursor
        break
      }
    }
    ops.push({ op: 'replace_section', section, content: lines.slice(index + 1, end).join('\n').trimEnd() })
  }
  return ops
}
