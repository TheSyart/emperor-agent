import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreConfigService } from './config-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('CoreConfigService (MIG-IPC-007)', () => {
  it('reads and writes USER.local.md without touching emperor.local.json', () => {
    const root = tmp('emperor-config-service-')
    mkdirSync(join(root, 'templates', 'init'), { recursive: true })
    writeFileSync(
      join(root, 'templates', 'init', 'USER.md'),
      '# Seed User\n\n',
      'utf8',
    )
    let refreshes = 0
    const service = new CoreConfigService(root, {
      refreshRuntimeContext: () => {
        refreshes += 1
      },
    })

    expect(service.getUserConfig()).toEqual({
      path: 'memory/profile/USER.local.md',
      content: '# Seed User\n\n',
    })
    expect(
      readFileSync(join(root, 'memory', 'profile', 'USER.local.md'), 'utf8'),
    ).toBe('# Seed User\n\n')
    expect(existsSync(join(root, 'emperor.local.json'))).toBe(false)

    expect(
      service.saveUserConfig('## Stable Preferences\n\n- 新的偏好\n'),
    ).toEqual({
      path: 'memory/profile/USER.local.md',
      content: '# Seed User\n\n## Stable Preferences\n\n- 新的偏好\n',
    })
    expect(
      readFileSync(join(root, 'memory', 'profile', 'USER.local.md'), 'utf8'),
    ).toBe('# Seed User\n\n## Stable Preferences\n\n- 新的偏好\n')
    expect(refreshes).toBe(1)
  })

  it('applies structured USER.local.md section edits through MemoryPatch and preserves unrelated sections', () => {
    const root = tmp('emperor-config-service-patch-')
    mkdirSync(join(root, 'memory', 'profile'), { recursive: true })
    writeFileSync(
      join(root, 'memory', 'profile', 'USER.local.md'),
      '# User Profile\n\n## Stable Preferences\n\n- old preference\n\n## Working Style\n\n- keep this section\n',
      'utf8',
    )
    const service = new CoreConfigService(root)

    service.saveUserConfig('## Stable Preferences\n\n- new preference\n')

    const saved = readFileSync(
      join(root, 'memory', 'profile', 'USER.local.md'),
      'utf8',
    )
    expect(saved).toContain('- new preference')
    expect(saved).toContain('- keep this section')
    expect(
      readFileSync(join(root, 'memory', 'patch-ledger.jsonl'), 'utf8'),
    ).toContain('memory_patch_applied')
  })

  it('rejects sectionless USER.local.md saves instead of bypassing MemoryPatch auditing', () => {
    const root = tmp('emperor-config-service-sectionless-')
    mkdirSync(join(root, 'memory', 'profile'), { recursive: true })
    const profilePath = join(root, 'memory', 'profile', 'USER.local.md')
    writeFileSync(
      profilePath,
      '# User Profile\n\n## Stable Preferences\n\n- existing\n',
      'utf8',
    )
    const service = new CoreConfigService(root)

    expect(() => service.saveUserConfig('plain text preference')).toThrow(
      'save_user_config requires at least one ## section',
    )

    expect(readFileSync(profilePath, 'utf8')).toBe(
      '# User Profile\n\n## Stable Preferences\n\n- existing\n',
    )
    expect(existsSync(join(root, 'memory', 'patch-ledger.jsonl'))).toBe(false)
  })

  it('saves MCP config and asks the host to reload MCP tools once', async () => {
    const root = tmp('emperor-config-mcp-')
    let reloads = 0
    const service = new CoreConfigService(root, {
      reloadMcp: () => {
        reloads += 1
      },
    })

    await expect(service.saveMcpConfig({ defaults: {} })).rejects.toThrow(
      "mcp_config: 'servers' must be an object",
    )

    const saved = await service.saveMcpConfig({
      servers: {
        docs: { transport: 'stdio', command: 'docs-mcp', enabled: true },
      },
      defaults: { read_only: true },
    })

    expect(saved.servers.docs).toMatchObject({
      name: 'docs',
      transport: 'stdio',
      command: 'docs-mcp',
      enabled: true,
    })
    expect(saved.defaults.read_only).toBe(true)
    expect(reloads).toBe(1)
  })

  it('never returns literal MCP secrets and preserves them across editor saves', async () => {
    const root = tmp('emperor-config-mcp-redaction-')
    const path = join(root, 'mcp_config.json')
    writeFileSync(
      path,
      JSON.stringify({
        servers: {
          remote: {
            transport: 'sse',
            enabled: true,
            url: 'https://secret-endpoint.example.test',
            headers: { Authorization: 'literal-secret-token' },
          },
        },
      }),
      'utf8',
    )
    let reloads = 0
    const service = new CoreConfigService(root, {
      reloadMcp: () => {
        reloads += 1
      },
    })

    const editor = await service.getMcpConfig()
    expect(editor.servers.remote).toMatchObject({
      url: '[REDACTED]',
      headers: { Authorization: '[REDACTED]' },
    })
    editor.servers.remote!.enabled = false
    const saved = await service.saveMcpConfig(
      editor as unknown as Record<string, unknown>,
    )

    expect(saved.servers.remote).toMatchObject({
      enabled: false,
      url: '[REDACTED]',
      headers: { Authorization: '[REDACTED]' },
    })
    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.servers.remote).toMatchObject({
      enabled: false,
      url: 'https://secret-endpoint.example.test',
      headers: { Authorization: 'literal-secret-token' },
    })
    expect(reloads).toBe(1)
  })
})
