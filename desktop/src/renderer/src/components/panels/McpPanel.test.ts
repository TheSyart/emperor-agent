// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import McpPanel from './McpPanel.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

describe('McpPanel', () => {
  it('renders explicit authentication state when a configured server has no tools', async () => {
    const mcpContent = JSON.stringify({
      servers: {
        'private-api': {
          transport: 'sse',
          enabled: true,
          url: 'https://mcp.example.test',
        },
      },
      defaults: {},
    })
    const context = {
      mcpContent: ref(mcpContent),
      boot: ref({
        tools: [],
        mcp: {
          initialized: true,
          configured: 1,
          ready: 0,
          tools: 0,
          servers: [
            {
              serverName: 'private-api',
              transport: 'sse',
              generation: 1,
              clientId: 'client_1',
              state: 'auth_failed',
              health: 'unhealthy',
              auth: 'failed',
              toolCount: 0,
              restartAttempts: 0,
              lastError: {
                code: 'mcp_auth_failed',
                message: 'MCP server authentication failed',
              },
            },
          ],
        },
      }),
      loadMcpConfig: vi.fn(async () => {}),
      loadMcpStatus: vi.fn(async () => undefined),
      saveMcpConfig: vi.fn(async () => {}),
      runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
    }
    container = document.createElement('div')
    document.body.append(container)
    const app = createApp(() => h(McpPanel))
    app.provide(APP_CONTEXT_KEY, context as never)
    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('已连接 0/1')
    expect(container.textContent).toContain('认证失败')
    expect(container.textContent).toContain('MCP server authentication failed')
    expect(container.textContent).toContain('private-api=auth_failed')
    expect(container.textContent).not.toContain(
      '配置并保存 MCP 服务器后即可看到工具列表',
    )
  })
})
