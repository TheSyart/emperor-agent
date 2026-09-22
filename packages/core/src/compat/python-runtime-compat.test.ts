import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadLocalConfig } from '../config/local-config'
import { activeEntry, loadModelConfig } from '../config/model-config'
import { MemoryStore } from '../memory/store'
import { loadMcpConfig } from '../mcp/config'
import { SessionStore } from '../sessions/store'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, '..', '..', 'fixtures', 'python-runtime')

describe('Python runtime data compatibility (MIG-REL-003)', () => {
  it('loads Python-layout settings, memory, model_config, mcp_config, and session index without migration prompts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-python-runtime-'))
    cpSync(fixtureDir, root, { recursive: true })

    // Retired keys (permissions.rules, workspace.git_rewind, memory.hybrid_memory)
    // are tolerated and ignored.
    const settings = await loadLocalConfig(root)
    expect(settings.desktopPet).toEqual({
      enabled: true,
      autoStartWithWebui: false,
    })
    expect(Object.keys(settings).sort()).toEqual([
      'desktopPet',
      'prompt',
      'webui',
    ])

    const model = await loadModelConfig(root, { create: false })
    expect(activeEntry(model)).toMatchObject({
      displayName: 'Python DeepSeek',
      provider: 'deepseek',
      protocol: 'openai',
      modelId: 'deepseek-chat',
    })
    expect(activeEntry(model)?.entryId).toMatch(/^model-/)
    expect(model.activeModelId).toBe(activeEntry(model)?.entryId)

    const mcp = await loadMcpConfig(root, { PY_TOOL: '/usr/bin/python3' })
    expect(mcp.defaults).toMatchObject({ read_only: true, exclusive: false })
    expect(mcp.servers.legacy_reader).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: '/usr/bin/python3',
      args: ['-m', 'legacy_reader'],
    })

    const memory = new MemoryStore(
      join(root, 'memory'),
      join(root, 'templates', 'USER.local.md'),
    )
    expect(memory.readMemory()).toContain('Python 版长期记忆')
    expect(
      readFileSync(join(root, 'memory', '2026-06-25.md'), 'utf8'),
    ).toContain('Python 版情景记忆')
    // Legacy history.jsonl is left untouched: the session log is the only
    // trajectory now, so the memory store neither reads nor rewrites it.
    const legacyHistory = readFileSync(
      join(fixtureDir, 'memory', 'history.jsonl'),
      'utf8',
    )
    expect(readFileSync(join(root, 'memory', 'history.jsonl'), 'utf8')).toBe(
      legacyHistory,
    )

    const sessions = new SessionStore(root).list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'default',
      title: 'Python 默认会话',
      message_count: 2,
    })
  })
})
