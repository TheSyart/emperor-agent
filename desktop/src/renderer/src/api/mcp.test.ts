import { afterEach, describe, expect, it } from 'vitest'
import {
  getMcpConfig,
  getMcpStatus,
  importMcpServers,
  previewMcpImport,
  removeMcpServer,
  setMcpServerEnabled,
} from './mcp'

const g = globalThis as unknown as { window?: any }

afterEach(() => {
  delete g.window
})

function bridge(reply: (key: string, input: unknown) => unknown = () => ({})) {
  const calls: unknown[][] = []
  g.window = {
    emperor: {
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        return reply(String(args[0]), args[1])
      },
    },
  }
  return calls
}

describe('MCP API Core IPC', () => {
  it('previews and imports pasted server JSON through mcp.importServers', async () => {
    const calls = bridge(() => ({ added: ['aihot'], dryRun: true }))
    const raw =
      '{"mcpServers":{"aihot":{"type":"http","url":"https://aihot.news/api/mcp"}}}'

    await expect(previewMcpImport(raw)).resolves.toMatchObject({
      added: ['aihot'],
    })
    await importMcpServers(raw, { overwrite: ['aihot'] })
    await importMcpServers({ mcpServers: {} })

    expect(calls).toEqual([
      ['mcp.importServers', { raw, dryRun: true }],
      ['mcp.importServers', { raw, overwrite: ['aihot'] }],
      ['mcp.importServers', { raw: { mcpServers: {} } }],
    ])
  })

  it('toggles, removes, and reads servers by name', async () => {
    const calls = bridge()

    await setMcpServerEnabled('aihot', false)
    await removeMcpServer('aihot')
    await getMcpConfig()
    await getMcpStatus()

    expect(calls).toEqual([
      ['mcp.setServerEnabled', { name: 'aihot', enabled: false }],
      ['mcp.removeServer', { name: 'aihot' }],
      ['mcp.getConfig'],
      ['mcp.status'],
    ])
  })

  it('surfaces the Core safe error message and code', async () => {
    bridge(() => ({
      ok: false,
      error: {
        message: '无法解析 MCP 配置：不是有效的 JSON',
        code: 'mcp_import_invalid',
      },
    }))

    await expect(previewMcpImport('nope')).rejects.toMatchObject({
      message: '无法解析 MCP 配置：不是有效的 JSON',
      code: 'mcp_import_invalid',
    })
  })
})
