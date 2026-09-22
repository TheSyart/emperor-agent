import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCPClient } from '../../../mcp/client'
import { startMcpHttpFixture, type McpHttpFixture } from '../../../mcp/testing'
import type { Session } from '../../../session-log/session'
import type { Agent } from '../../agent/agent'
import type { ApprovalOutcome, ApprovalService } from '../../approval/service'
import { McpToolBridge } from '../../host/mcp-tools'
import { SystemPromptAssembler } from '../../prompt/assembler'
import { SandboxPolicyService, type SandboxMode } from '../../sandbox/policy'
import { textOf } from '../definition'
import { ToolRegistry } from '../registry'
import {
  createMcpConfigTool,
  installMcpConfigPromptSection,
  mcpConfigDisplayPath,
} from './mcp-config'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fakeAgent(root: string, mode: SandboxMode): Agent {
  const session = {
    id: 'session-1',
    header: { cwd: root },
    events: [{ type: 'sandbox/mode', data: { mode }, seq: 0, time: 0 }],
  } as unknown as Session
  return { id: 'session-1', session } as unknown as Agent
}

function setup(
  options: {
    mode?: SandboxMode
    answer?: ApprovalOutcome
    config?: Record<string, unknown>
    client?: MCPClient
  } = {},
) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-mcp-config-tool-'))
  if (options.config)
    writeFileSync(
      join(stateRoot, 'mcp_config.json'),
      JSON.stringify(options.config),
      'utf8',
    )
  const approvals: string[] = []
  const approval = {
    async request(request: { toolName: string; reason?: string }) {
      approvals.push(`${request.toolName}: ${request.reason ?? ''}`)
      return options.answer ?? 'allowed-once'
    },
  } as unknown as ApprovalService
  const registry = new ToolRegistry()
  const client =
    options.client ??
    new MCPClient(stateRoot, {
      supervisor: { connectTimeoutMs: 5_000, maxRestartAttempts: 1 },
    })
  cleanups.push(async () => await client.close())
  const bridge = new McpToolBridge(client, registry)
  let reloads = 0
  registry.register(
    createMcpConfigTool({
      stateRoot,
      sandbox: new SandboxPolicyService({
        defaultMode: 'workspace-write',
        workspaceRoot: stateRoot,
      }),
      approval,
      reload: async () => {
        reloads += 1
        await client.reload()
        bridge.sync()
      },
      status: () => client.snapshot(),
    }),
  )
  const agent = fakeAgent(stateRoot, options.mode ?? 'workspace-write')
  let callCounter = 0
  const call = async (args: Record<string, unknown>) => {
    const result = await registry.execute({
      callId: `c${++callCounter}`,
      name: 'mcp_config',
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
    return { isError: result.isError, text: textOf(result.content) }
  }
  const stored = () =>
    JSON.parse(readFileSync(join(stateRoot, 'mcp_config.json'), 'utf8')) as {
      servers: Record<string, Record<string, unknown>>
    }
  return {
    stateRoot,
    approvals,
    registry,
    call,
    stored,
    reloads: () => reloads,
  }
}

async function fixture(): Promise<McpHttpFixture> {
  const started = await startMcpHttpFixture()
  cleanups.push(async () => await started.close())
  return started
}

describe('mcp_config tool', () => {
  it('asks for approval under workspace-write, then adds, reloads, and registers the server tools', async () => {
    const server = await fixture()
    const f = setup({ mode: 'workspace-write' })

    const added = await f.call({
      action: 'add',
      config: JSON.stringify({
        mcpServers: {
          local: { type: 'http', url: `${server.url}?key=s3cret` },
        },
      }),
    })

    expect(added.isError).toBe(false)
    expect(f.approvals).toHaveLength(1)
    expect(f.approvals[0]).toContain('mcp_config: ')
    expect(f.approvals[0]).toContain('新增 MCP server "local" [http]')
    expect(f.approvals[0]).toContain('?key=[REDACTED]')
    expect(f.approvals[0]).not.toContain('s3cret')
    expect(f.stored().servers.local).toMatchObject({
      transport: 'http',
      url: `${server.url}?key=s3cret`,
    })
    expect(f.reloads()).toBe(1)
    expect(added.text).toContain('local: ready')
    expect(added.text).toContain('mcp_local_echo')
    expect(f.registry.get('mcp_local_echo')).toBeDefined()

    const listed = await f.call({ action: 'list' })
    expect(listed.text).toContain('- local [http] ready · 1 tools')
    expect(listed.text).not.toContain('s3cret')
    expect(f.approvals).toHaveLength(1)
  })

  it('applies writes without approval under danger-full-access', async () => {
    const f = setup({ mode: 'danger-full-access' })

    const added = await f.call({
      action: 'add',
      name: 'docs',
      config: { command: 'definitely-not-a-real-mcp-binary', args: ['--x'] },
    })
    expect(added.isError).toBe(false)
    expect(f.stored().servers.docs).toEqual({
      transport: 'stdio',
      enabled: true,
      command: 'definitely-not-a-real-mcp-binary',
      args: ['--x'],
    })
    expect((await f.call({ action: 'disable', name: 'docs' })).isError).toBe(
      false,
    )
    expect(f.stored().servers.docs?.enabled).toBe(false)
    expect((await f.call({ action: 'remove', name: 'docs' })).isError).toBe(
      false,
    )
    expect(f.stored().servers.docs).toBeUndefined()
    expect(f.approvals).toEqual([])
  })

  it('returns a tool error and leaves the config untouched when the user rejects', async () => {
    const f = setup({
      mode: 'read-only',
      answer: 'rejected',
      config: { servers: { keep: { command: 'keep-me', enabled: false } } },
    })

    const added = await f.call({
      action: 'add',
      config: { mcpServers: { other: { url: 'https://other.test/mcp' } } },
    })
    expect(added.isError).toBe(true)
    expect(added.text).toContain('rejected')
    const removed = await f.call({ action: 'remove', name: 'keep' })
    expect(removed.isError).toBe(true)
    expect(f.approvals).toEqual([
      expect.stringContaining(
        '新增 MCP server "other" [http] https://other.test/mcp',
      ),
      expect.stringContaining('删除 MCP server "keep" [stdio] keep-me'),
    ])
    expect(Object.keys(f.stored().servers)).toEqual(['keep'])
    expect(f.reloads()).toBe(0)
  })

  it('skips existing servers without asking unless overwrite is set', async () => {
    const f = setup({
      config: {
        servers: { docs: { transport: 'http', url: 'https://docs.test/mcp' } },
      },
    })

    const skipped = await f.call({
      action: 'add',
      config: { mcpServers: { docs: { url: 'https://docs.test/v2' } } },
    })
    expect(skipped.isError).toBe(false)
    expect(skipped.text).toContain('skipped')
    expect(skipped.text).toContain('未覆盖')
    expect(f.approvals).toEqual([])

    const replaced = await f.call({
      action: 'add',
      overwrite: true,
      config: { mcpServers: { docs: { url: 'https://docs.test/v2' } } },
    })
    expect(replaced.isError).toBe(false)
    expect(f.approvals).toEqual([
      expect.stringContaining('覆盖 MCP server "docs"'),
    ])
    expect(f.stored().servers.docs?.url).toBe('https://docs.test/v2')
  })

  it('reports invalid input and unknown servers as tool errors', async () => {
    const f = setup()
    expect((await f.call({ action: 'add' })).text).toContain('requires config')
    expect(
      (await f.call({ action: 'add', config: 'not json [' })).text,
    ).toContain('无法解析')
    expect((await f.call({ action: 'enable' })).text).toContain('requires name')
    expect(
      (await f.call({ action: 'remove', name: 'missing' })).text,
    ).toContain('not configured')
    expect((await f.call({ action: 'list' })).text).toContain(
      'No MCP servers configured',
    )
    expect(f.approvals).toEqual([])
  })

  it('installs a prompt section that pins MCP management to mcp_config', () => {
    const prompt = new SystemPromptAssembler()
    installMcpConfigPromptSection(prompt, {
      configPath: '~/.emperor/mcp_config.json',
    })
    const text = prompt.assemble().sections[0]?.text ?? ''
    expect(text).toContain('~/.emperor/mcp_config.json')
    expect(text).toContain('mcp_config tool')
    expect(text).toContain('Never use mcporter')
    expect(text).toContain('~/.claude.json')
    expect(mcpConfigDisplayPath('/opt/emperor')).toBe(
      '/opt/emperor/mcp_config.json',
    )
  })
})
