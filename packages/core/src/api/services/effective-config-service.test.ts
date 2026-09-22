import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillManager } from '../../skills/manager'
import { CoreEffectiveConfigService } from './effective-config-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('CoreEffectiveConfigService', () => {
  it('is diagnostics-safe and never isolates corrupt legacy inputs', async () => {
    const root = tmp('emperor-effective-config-corrupt-')
    writeFileSync(join(root, 'emperor.local.json'), '{bad local', 'utf8')
    writeFileSync(join(root, 'mcp_config.json'), '{bad mcp', 'utf8')

    const payload = await new CoreEffectiveConfigService(root).payload()

    expect(payload.entries.map((entry) => entry.key)).toEqual([
      'mcp.config',
      'sandbox.runtime',
    ])
    expect(existsSync(join(root, 'emperor.local.json'))).toBe(true)
    expect(existsSync(join(root, 'mcp_config.json'))).toBe(true)
    expect(
      readdirSync(root).filter((name) => name.includes('.corrupt-')),
    ).toEqual([])
  })

  it('exposes model execution policy provenance without model credentials', async () => {
    const root = tmp('emperor-effective-model-policy-')
    writeFileSync(
      join(root, 'model_config.json'),
      JSON.stringify({
        schemaVersion: 2,
        activeModelId: 'primary',
        models: [
          {
            entryId: 'primary',
            provider: 'openai',
            protocol: 'openai',
            modelId: 'gpt-5',
            apiBase: 'https://api.openai.com/v1',
            apiKey: 'secret-must-not-escape',
            contextWindowTokens: 128000,
            maxTokens: 8000,
            reasoningEffort: null,
          },
        ],
        policy: {
          fallback: {
            enabled: false,
            entryId: null,
            triggerOn: ['rate_limit'],
          },
          cost: { maxUsdPerAgentTurn: null },
        },
      }),
    )

    const payload = await new CoreEffectiveConfigService(root).payload()
    expect(
      payload.entries.find((entry) => entry.key === 'model.executionPolicy'),
    ).toMatchObject({
      source: {
        kind: 'user',
        id: 'model_config.json',
        trust: 'trusted',
      },
      value: {
        fallback: { enabled: false, triggerOn: ['rate_limit'] },
        cost: { maxUsdPerAgentTurn: null },
      },
    })
    expect(JSON.stringify(payload)).not.toContain('secret-must-not-escape')
  })

  it('adapts canonical MCP/skill sources (ignoring retired settings keys) into a reproducible redacted snapshot', async () => {
    const root = tmp('emperor-effective-config-')
    const runtimeRoot = join(root, 'runtime')
    const stateRoot = join(root, 'state')
    mkdirSync(join(runtimeRoot, 'skills', 'builtin-skill'), {
      recursive: true,
    })
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(
      join(runtimeRoot, 'skills', 'builtin-skill', 'SKILL.md'),
      '---\nname: builtin-skill\ndescription: Built in\n---\n',
    )
    writeFileSync(
      join(stateRoot, 'settings.json'),
      JSON.stringify({
        codeIntelligence: { mode: 'eval' },
        memory: { hybridMemory: 'eval' },
        workspace: { gitRewind: { mode: 'eval' } },
        permissions: {
          rules: [
            {
              id: 'deny-secrets',
              action: 'deny',
              tool: 'read_file',
              pathGlob: '.env',
            },
          ],
        },
      }),
    )
    const secret = 'literal-secret-that-must-not-escape'
    writeFileSync(
      join(stateRoot, 'mcp_config.json'),
      JSON.stringify({
        servers: {
          remote: {
            transport: 'sse',
            url: `https://mcp.invalid/?token=${secret}`,
            args: [`--token=${secret}`],
            env: { TOKEN: secret },
            headers: { Authorization: `Bearer ${secret}` },
          },
        },
      }),
    )
    const service = new CoreEffectiveConfigService(stateRoot, {
      skillManager: new SkillManager({ runtimeRoot, stateRoot }),
    })

    const first = await service.payload()
    const second = await service.payload()
    const serialized = JSON.stringify(first)

    expect(first).toEqual(second)
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(first.entries.map((entry) => entry.key)).toEqual([
      'mcp.config',
      'sandbox.runtime',
      'skills.builtin-skill',
    ])
    expect(
      first.entries.find((entry) => entry.key === 'skills.builtin-skill'),
    ).toMatchObject({
      source: { kind: 'builtin' },
      value: { name: 'builtin-skill', source: 'builtin' },
    })
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('--token')
    expect(serialized).not.toContain('https://mcp.invalid')
  })
})
