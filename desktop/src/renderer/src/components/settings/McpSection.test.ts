// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'
import McpSection from './McpSection.vue'
import { MCP_PREVIEW_DEBOUNCE_MS } from './mcp/useMcpImportPreview'

type Dict = Record<string, any>

const AIHOT_JSON =
  '{"mcpServers":{"aihot":{"type":"http","url":"https://aihot.news/api/mcp?aihot_actor=abc"}}}'

let app: App | null = null
let container: HTMLDivElement | null = null
let calls: Array<[string, unknown]> = []
let servers: Dict = {}
let statusServers: Dict[] = []
let replies: Record<string, (input: any) => unknown> = {}

function status() {
  return {
    initialized: true,
    servers: statusServers,
    ready: statusServers.filter((server) => server.state === 'ready').length,
    configured: statusServers.length,
    tools: 0,
    toolCapabilities: [],
  }
}

function config() {
  return { servers: JSON.parse(JSON.stringify(servers)), defaults: {} }
}

function server(patch: Dict): Dict {
  return {
    transport: 'stdio',
    enabled: true,
    command: null,
    args: [],
    env: {},
    url: null,
    headers: {},
    tool_overrides: {},
    ...patch,
  }
}

function plan(patch: Dict = {}): Dict {
  return {
    added: [],
    updated: [],
    skipped: [],
    conflicts: [],
    warnings: [],
    servers: [],
    dryRun: true,
    config: config(),
    status: status(),
    ...patch,
  }
}

function installBridge() {
  calls = []
  ;(window as unknown as { emperor: unknown }).emperor = {
    invokeCore: async (key: string, input?: unknown) => {
      calls.push([key, input])
      const reply = replies[key]
      if (reply) return reply(input)
      switch (key) {
        case 'mcp.getConfig':
          return config()
        case 'mcp.status':
          return status()
        case 'bootstrap':
          return { tools: context.boot.value.tools, mcp: status() }
        default:
          return {}
      }
    },
  }
}

const context = {
  boot: ref<Dict>({ tools: [], mcp: null }),
  showToast: vi.fn(),
  saveMcpConfig: vi.fn(async () => {}),
  runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await nextTick()
}

function mount() {
  const header = createSettingsHeader()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(McpSection) })
  app.provide(APP_CONTEXT_KEY, context as never)
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(container)
  return header
}

function card(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `.mcp-server-card[data-server="${name}"]`,
  )
  if (!found) throw new Error(`no card ${name}`)
  return found
}

function dialog(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[role="dialog"][aria-label="${name}"]`,
  )
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input'))
}

async function openAdd(header: ReturnType<typeof createSettingsHeader>) {
  const add = header.actions.value.find((action) => action.id === 'add')
  expect(add).toMatchObject({ label: '添加', kind: 'primary' })
  add!.onClick!()
  await nextTick()
  const root = dialog('添加 MCP 服务器')
  expect(root).not.toBeNull()
  return root!
}

beforeEach(() => {
  servers = {}
  statusServers = []
  replies = {}
  context.boot.value = { tools: [], mcp: null }
  context.showToast.mockReset()
  installBridge()
})

afterEach(() => {
  vi.useRealTimers()
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  delete (window as unknown as { emperor?: unknown }).emperor
})

describe('McpSection server cards', () => {
  it('shows the authentication failure of a server without tools', async () => {
    servers = {
      'private-api': server({
        transport: 'sse',
        url: 'https://mcp.example.test',
      }),
    }
    statusServers = [
      {
        serverName: 'private-api',
        transport: 'sse',
        generation: 1,
        state: 'auth_failed',
        health: 'unhealthy',
        auth: 'failed',
        toolCount: 0,
        tools: [],
        lastError: {
          code: 'mcp_auth_failed',
          message: 'MCP server authentication failed',
        },
      },
    ]
    mount()
    await settle()

    const text = document.body.textContent ?? ''
    expect(text).toContain('已连接 0/1')
    const item = card('private-api')
    expect(item.dataset.state).toBe('failed')
    expect(item.textContent).toContain('SSE')
    expect(item.textContent).toContain(
      '认证失败 · MCP server authentication failed',
    )

    item.querySelector<HTMLButtonElement>('button.head-text')!.click()
    await nextTick()
    expect(item.textContent).toContain('最近错误')
    expect(item.textContent).toContain(
      'MCP server authentication failed（mcp_auth_failed）',
    )
    expect(item.textContent).toContain('连接未成功，尚未加载工具。')
  })

  it('lists tools with descriptions and toggles / removes a server', async () => {
    servers = {
      aihot: server({
        transport: 'http',
        url: 'https://aihot.news/api/mcp?aihot_actor=[REDACTED]',
      }),
    }
    statusServers = [
      {
        serverName: 'aihot',
        state: 'ready',
        toolCount: 1,
        tools: ['get_hot_topics'],
      },
    ]
    context.boot.value.tools = [
      {
        name: 'mcp_aihot_get_hot_topics',
        description: '获取热门话题',
        source: 'mcp',
        server: 'aihot',
      },
    ]
    replies['mcp.setServerEnabled'] = (input) => {
      servers.aihot.enabled = input.enabled
      statusServers = []
      return { ...input, changed: true, config: config(), status: status() }
    }
    replies['mcp.removeServer'] = (input) => {
      delete servers[input.name]
      return { removed: input.name, config: config(), status: status() }
    }
    mount()
    await settle()

    const item = card('aihot')
    expect(item.textContent).toContain('已连接 · 1 个工具')
    item.querySelector<HTMLButtonElement>('button.head-text')!.click()
    await nextTick()
    expect(item.textContent).toContain(
      'https://aihot.news/api/mcp?aihot_actor=***',
    )
    expect(item.querySelector('.tool-name')?.textContent).toBe('get_hot_topics')
    expect(item.querySelector('.tool-description')?.textContent).toContain(
      '获取热门话题',
    )

    item.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    await settle()
    expect(calls).toContainEqual([
      'mcp.setServerEnabled',
      { name: 'aihot', enabled: false },
    ])
    expect(card('aihot').dataset.state).toBe('disabled')
    expect(context.showToast).toHaveBeenCalledWith('已停用 aihot')
    expect(calls.some(([key]) => key === 'bootstrap')).toBe(true)

    buttonByText(card('aihot'), '删除').click()
    await nextTick()
    const confirm = dialog('删除 aihot？')
    expect(confirm).not.toBeNull()
    confirm!
      .querySelector<HTMLButtonElement>('[data-testid="mcp-remove-confirm"]')!
      .click()
    await settle()
    expect(calls).toContainEqual(['mcp.removeServer', { name: 'aihot' }])
    expect(document.querySelector('.mcp-server-card')).toBeNull()
    expect(dialog('删除 aihot？')).toBeNull()
    expect(context.showToast).toHaveBeenCalledWith('已删除 MCP 服务器「aihot」')
    expect(document.body.textContent).toContain('还没有 MCP 服务器')
  })
})

describe('McpSection add dialog', () => {
  it('previews pasted JSON (dry run) and imports it', async () => {
    vi.useFakeTimers()
    replies['mcp.importServers'] = (input) => {
      const row = {
        name: 'aihot',
        transport: 'http',
        target: 'https://aihot.news/api/mcp?aihot_actor=[REDACTED]',
        enabled: true,
        action: 'add',
        conflict: false,
      }
      if (input.dryRun) return plan({ added: ['aihot'], servers: [row] })
      servers.aihot = server({ transport: 'http', url: row.target })
      statusServers = [
        { serverName: 'aihot', state: 'ready', toolCount: 0, tools: [] },
      ]
      return plan({ added: ['aihot'], servers: [row], dryRun: false })
    }
    const header = mount()
    await settle()
    expect(document.body.textContent).toContain('还没有 MCP 服务器')

    const root = await openAdd(header)
    const submit = root.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-import-submit"]',
    )!
    expect(submit.disabled).toBe(true)
    type(root.querySelector('textarea')!, AIHOT_JSON)
    await nextTick()
    expect(calls.some(([key]) => key === 'mcp.importServers')).toBe(false)

    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    await settle()
    expect(calls).toContainEqual([
      'mcp.importServers',
      { raw: AIHOT_JSON, overwrite: true, dryRun: true },
    ])
    const row = root.querySelector<HTMLElement>('.row[data-server="aihot"]')!
    expect(row.dataset.kind).toBe('add')
    expect(row.textContent).toContain('HTTP')
    expect(row.textContent).toContain('新增')
    expect(row.textContent).toContain('aihot_actor=***')
    expect(root.textContent).toContain('识别到 1 个服务器')
    expect(submit.disabled).toBe(false)

    submit.click()
    await settle()
    expect(calls).toContainEqual(['mcp.importServers', { raw: AIHOT_JSON }])
    expect(dialog('添加 MCP 服务器')).toBeNull()
    expect(context.showToast).toHaveBeenCalledWith(
      '已导入 MCP 服务器：新增 1 个',
    )
    expect(card('aihot').dataset.state).toBe('connected')
    expect(calls.some(([key]) => key === 'bootstrap')).toBe(true)
  })

  it('imports a conflicting server only with its 覆盖 box checked', async () => {
    vi.useFakeTimers()
    servers = { aihot: server({ transport: 'http', url: 'https://old.test' }) }
    replies['mcp.importServers'] = (input) => {
      const replace =
        input.overwrite === true ||
        (Array.isArray(input.overwrite) && input.overwrite.includes('aihot'))
      return plan({
        conflicts: ['aihot'],
        updated: replace ? ['aihot'] : [],
        skipped: replace ? [] : ['aihot'],
        dryRun: Boolean(input.dryRun),
        servers: [
          {
            name: 'aihot',
            transport: 'http',
            target: 'https://aihot.news/api/mcp',
            enabled: true,
            action: replace ? 'update' : 'skip',
            conflict: true,
          },
        ],
      })
    }
    const header = mount()
    await settle()
    const root = await openAdd(header)
    type(root.querySelector('textarea')!, AIHOT_JSON)
    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    await settle()

    const row = root.querySelector<HTMLElement>('.row[data-server="aihot"]')!
    expect(row.dataset.kind).toBe('skip')
    const submit = root.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-import-submit"]',
    )!
    expect(submit.disabled).toBe(true)

    const overwrite = row.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!
    overwrite.checked = true
    overwrite.dispatchEvent(new Event('change'))
    await nextTick()
    expect(row.dataset.kind).toBe('update')
    expect(submit.disabled).toBe(false)

    submit.click()
    await settle()
    expect(calls).toContainEqual([
      'mcp.importServers',
      { raw: AIHOT_JSON, overwrite: ['aihot'] },
    ])
    expect(context.showToast).toHaveBeenCalledWith(
      '已导入 MCP 服务器：更新 1 个',
    )
  })

  it('shows the Core parse error and keeps 导入 disabled', async () => {
    vi.useFakeTimers()
    replies['mcp.importServers'] = () => ({
      ok: false,
      error: {
        message: '无法解析 MCP 配置：不是有效的 JSON',
        code: 'mcp_import_invalid',
      },
    })
    const header = mount()
    await settle()
    const root = await openAdd(header)
    type(root.querySelector('textarea')!, 'not json')
    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    await settle()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      '无法解析 MCP 配置：不是有效的 JSON',
    )
    expect(
      root.querySelector<HTMLButtonElement>(
        '[data-testid="mcp-import-submit"]',
      )!.disabled,
    ).toBe(true)
  })

  it('builds the raw import object from the 表单 tab', async () => {
    vi.useFakeTimers()
    replies['mcp.importServers'] = (input) =>
      plan({
        added: ['local-tools'],
        dryRun: Boolean(input.dryRun),
        servers: [
          {
            name: 'local-tools',
            transport: 'stdio',
            target: 'npx -y @acme/mcp',
            enabled: true,
            action: 'add',
            conflict: false,
          },
        ],
      })
    const header = mount()
    await settle()
    const root = await openAdd(header)
    buttonByText(root, '表单').click()
    await nextTick()

    type(
      root.querySelector<HTMLInputElement>('input[placeholder="aihot"]')!,
      'local-tools',
    )
    await nextTick()
    buttonByText(root, 'stdio').click()
    await nextTick()
    type(
      root.querySelector<HTMLInputElement>('input[placeholder="npx"]')!,
      'npx -y @acme/mcp',
    )
    await nextTick()
    buttonByText(root, '添加环境变量').click()
    await nextTick()
    type(
      root.querySelector<HTMLInputElement>('input[placeholder="API_KEY"]')!,
      'TOKEN',
    )
    await nextTick()
    await vi.advanceTimersByTimeAsync(MCP_PREVIEW_DEBOUNCE_MS)
    await settle()

    const raw = {
      mcpServers: {
        'local-tools': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@acme/mcp'],
          env: { TOKEN: '' },
        },
      },
    }
    expect(calls).toContainEqual([
      'mcp.importServers',
      { raw, overwrite: true, dryRun: true },
    ])
    root
      .querySelector<HTMLButtonElement>('[data-testid="mcp-import-submit"]')!
      .click()
    await settle()
    expect(calls).toContainEqual(['mcp.importServers', { raw }])
  })

  it('keeps Escape inside the nested dialog', async () => {
    const header = mount()
    await settle()
    await openAdd(header)
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    document.body.dispatchEvent(event)
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(dialog('添加 MCP 服务器')).toBeNull()
  })
})

describe('McpSection advanced editor', () => {
  it('saves the raw mcp_config.json through saveMcpConfig', async () => {
    servers = { aihot: server({ transport: 'http', url: 'https://a.test' }) }
    mount()
    await settle()
    const advanced = [
      ...document.querySelectorAll<HTMLElement>('.ds-settings-card'),
    ].find((item) => item.textContent?.includes('原始配置'))!
    advanced.querySelector<HTMLButtonElement>('button.head-text')!.click()
    await nextTick()
    const editor = advanced.querySelector('textarea')!
    expect(editor.value).toContain('"aihot"')

    type(editor, '{ "servers": ')
    await nextTick()
    buttonByText(advanced, '保存').click()
    await settle()
    expect(advanced.textContent).toContain('JSON 格式错误')
    expect(context.saveMcpConfig).not.toHaveBeenCalled()

    const next = JSON.stringify({ servers: {}, defaults: {} })
    type(editor, next)
    await nextTick()
    buttonByText(advanced, '保存').click()
    await settle()
    expect(context.saveMcpConfig).toHaveBeenCalledWith(next)
  })
})
