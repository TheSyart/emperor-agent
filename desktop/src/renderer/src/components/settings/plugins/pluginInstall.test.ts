// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PluginInstallDialog from './PluginInstallDialog.vue'
import {
  activationState,
  capabilityChips,
  formatBytes,
  scopeLabel,
  signatureLabel,
  sourceLabel,
  usePluginInstall,
  type PluginPreview,
  type PluginSummary,
} from './pluginInstall'

vi.mock('../../../api/http', () => ({ core: vi.fn() }))
vi.mock('../../../api/backend', () => ({
  selectDirectory: vi.fn(),
  selectFile: vi.fn(),
}))

function preview(patch: Partial<PluginPreview> = {}): PluginPreview {
  return {
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
    ...patch,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

describe('plugin display vocabulary', () => {
  it('labels scope, signature, source and runtime state', () => {
    expect(scopeLabel('user')).toBe('用户')
    expect(scopeLabel('project')).toBe('项目')
    expect(scopeLabel('local')).toBe('本地项目')
    expect(scopeLabel('managed')).toBe('受管')
    expect(signatureLabel('verified')).toBe('签名已验证')
    expect(signatureLabel('local_user_source')).toBe('本地来源')
    expect(signatureLabel('unverified')).toBe('未验证签名')
    expect(sourceLabel({ kind: 'local', label: 'kit' })).toBe('本地 · kit')
    expect(sourceLabel({ kind: 'url', url: 'https://x.test/a.zip' })).toBe(
      'https://x.test/a.zip',
    )
    const summary = { activation: 'blocked_unverified' } as PluginSummary
    expect(activationState(summary)).toEqual({
      label: '签名未验证 · 未激活',
      tone: 'warn',
    })
    expect(
      activationState({ activation: 'active' } as PluginSummary).tone,
    ).toBe('ok')
  })

  it('counts capabilities from lists or numbers and formats sizes', () => {
    expect(capabilityChips(preview().capabilities)).toEqual([
      'Skill · 1',
      'Hook · 1',
    ])
    expect(
      capabilityChips({
        skills: 0,
        agents: 0,
        hooks: 0,
        mcpServers: 2,
        lspServers: 0,
        commands: 1,
      }),
    ).toEqual(['MCP · 2', 'Command · 1'])
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(18_432)).toBe('18.0 KB')
  })
})

describe('usePluginInstall', () => {
  it('inspects a picked local folder, then installs the confirmed digest', async () => {
    const inspect = vi.fn(async () =>
      preview({
        source: { kind: 'local', label: 'kit' },
        signature: { status: 'local_user_source', publisher: null },
      }),
    )
    const install = vi.fn(async () => ({}))
    const onInstalled = vi.fn()
    const flow = usePluginInstall({
      inspect,
      install,
      pickFolder: async () => '/tmp/kit',
      onInstalled,
    })

    await flow.installLocal('folder')
    expect(inspect).toHaveBeenCalledWith({ kind: 'local', path: '/tmp/kit' })
    expect(flow.state.step).toBe('preview')
    expect(flow.open.value).toBe(true)

    flow.setScope('project')
    await flow.confirm()
    expect(install).toHaveBeenCalledWith({
      previewId: 'plugin_preview_aaaaaaaaaaaaaaaaaaaaaaaa',
      digest: 'a'.repeat(64),
      scope: 'project',
    })
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(flow.state.step).toBe('closed')
    expect(flow.state.installed).toBe('Agent Reach')
  })

  it('inspects a zip file and ignores a cancelled pick', async () => {
    const inspect = vi.fn(async () => preview())
    const flow = usePluginInstall({
      inspect,
      pickZip: async () => null,
      onInstalled: vi.fn(),
    })
    await flow.installLocal('zip')
    expect(inspect).not.toHaveBeenCalled()
    expect(flow.state.step).toBe('closed')
  })

  it('keeps a failed local inspection open with its error', async () => {
    const flow = usePluginInstall({
      inspect: async () => {
        throw new Error('invalid Plugin schema')
      },
      pickFolder: async () => '/tmp/broken',
      onInstalled: vi.fn(),
    })
    await flow.installLocal('folder')
    expect(flow.state.step).toBe('preview')
    expect(flow.state.preview).toBeNull()
    expect(flow.state.error).toBe('invalid Plugin schema')
  })

  it('requires https for URL installs before inspecting', async () => {
    const inspect = vi.fn(async () => preview())
    const flow = usePluginInstall({ inspect, onInstalled: vi.fn() })
    flow.openUrl()
    expect(flow.state.step).toBe('url')
    flow.setUrl('http://example.test/plugin.zip')
    await flow.inspectUrl()
    expect(inspect).not.toHaveBeenCalled()
    expect(flow.state.error).toContain('https://')

    flow.setUrl('https://example.test/plugin.zip')
    await flow.inspectUrl()
    expect(inspect).toHaveBeenCalledWith({
      kind: 'url',
      url: 'https://example.test/plugin.zip',
    })
    expect(flow.state.step).toBe('preview')
  })

  it('drops a preview that arrives after the dialog was closed', async () => {
    let resolve: (value: PluginPreview) => void = () => {}
    const flow = usePluginInstall({
      inspect: () => new Promise<PluginPreview>((done) => (resolve = done)),
      onInstalled: vi.fn(),
    })
    flow.openUrl()
    flow.setUrl('https://example.test/plugin.zip')
    const pending = flow.inspectUrl()
    flow.close()
    resolve(preview())
    await pending
    expect(flow.state.step).toBe('closed')
    expect(flow.state.preview).toBeNull()
  })
})

describe('PluginInstallDialog', () => {
  async function mountDialog(
    setup: (flow: ReturnType<typeof usePluginInstall>) => Promise<void>,
  ) {
    const flow = usePluginInstall({
      inspect: async () => preview(),
      onInstalled: vi.fn(),
    })
    await setup(flow)
    container = document.createElement('div')
    document.body.append(container)
    app = createApp(() => h(PluginInstallDialog, { flow }))
    app.mount(container)
    await flush()
    return flow
  }

  it('explains that URL installs need signature verification', async () => {
    await mountDialog(async (flow) => flow.openUrl())
    const text = document.body.textContent ?? ''
    expect(text).toContain('必须通过签名验证才会激活')
    expect(
      document.body.querySelector('[data-testid="plugin-source"]'),
    ).not.toBeNull()
  })

  it('shows source, version, digest, signature, scope and capabilities before install', async () => {
    await mountDialog(async (flow) => {
      flow.openUrl()
      flow.setUrl('https://example.test/plugin.zip')
      await flow.inspectUrl()
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('安装「Agent Reach」')
    expect(text).toContain('https://example.test/plugin.zip')
    expect(text).toContain('1.2.3')
    expect(text).toContain('aaaaaaaaaaaaaaaa…')
    expect(text).toContain('未验证签名')
    expect(text).toContain('用户')
    expect(text).toContain('Skill · 1')
    expect(text).toContain('Hook · 1')
    expect(text).toContain('签名未验证：安装后不会激活')
    expect(
      document.body.querySelector('[data-testid="confirm-plugin-install"]'),
    ).not.toBeNull()
  })

  it('closes on Escape and marks it handled for the settings modal underneath', async () => {
    const flow = await mountDialog(async (flow) => flow.openUrl())
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(flow.open.value).toBe(false)
  })
})
