// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PluginsPanel from './PluginsPanel.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
  core.mockReset()
})

describe('PluginsPanel', () => {
  it('shows source, version, digest, signature, scope, and capabilities before install', async () => {
    core.mockResolvedValueOnce({
      previewId: 'plugin_preview_aaaaaaaaaaaaaaaaaaaaaaaa',
      pluginId: 'official/agent-reach',
      name: 'Agent Reach',
      version: '1.2.3',
      description: 'Reach the web',
      digest: 'a'.repeat(64),
      source: { kind: 'url', url: 'https://example.test/plugin.zip' },
      signature: { status: 'unverified', publisher: null },
      capabilities: {
        skills: ['skills'],
        agents: [],
        hooks: ['hooks/hooks.json'],
        mcpServers: [],
        lspServers: [],
        commands: [],
      },
      fileCount: 4,
      totalBytes: 128,
    })
    container = document.createElement('div')
    document.body.append(container)
    createApp(PluginsPanel, { plugins: [] }).mount(container)

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="plugin-source"]',
    )!
    input.value = 'https://example.test/plugin.zip'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    container
      .querySelector<HTMLButtonElement>('[data-testid="inspect-plugin"]')!
      .click()
    await nextTick()
    await nextTick()

    expect(container.textContent).toContain('Agent Reach')
    expect(container.textContent).toContain('1.2.3')
    expect(container.textContent).toContain('aaaaaaaaaaaaaaaa')
    expect(container.textContent).toContain('未验证签名')
    expect(container.textContent).toContain('用户')
    expect(container.textContent).toContain('Skill')
    expect(container.textContent).toContain('Hook')
  })
})
