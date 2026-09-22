import { describe, expect, it } from 'vitest'
import {
  buildMcpServerRaw,
  buildMcpServerViews,
  emptyMcpServerForm,
  mcpCardState,
  mcpImportableCount,
  mcpImportSummary,
  mcpPreviewRows,
  mcpServerFacts,
  mcpServerSummary,
  pruneOverwrite,
  splitCommandLine,
  validateMcpServerForm,
  type McpImportPlanLike,
  type McpServerFormState,
} from './mcpModel'

describe('mcpCardState', () => {
  it('maps connection states onto the four card states', () => {
    expect(mcpCardState(true, { state: 'ready' })).toEqual({
      state: 'connected',
      label: '已连接',
      tone: 'ok',
    })
    expect(mcpCardState(true, { state: 'connecting' }).state).toBe('connecting')
    expect(mcpCardState(true, { state: 'backoff' })).toMatchObject({
      state: 'connecting',
      label: '等待重试',
    })
    expect(mcpCardState(true, { state: 'auth_failed' })).toEqual({
      state: 'failed',
      label: '认证失败',
      tone: 'error',
    })
    expect(mcpCardState(true, { state: 'degraded' }).state).toBe('failed')
    expect(mcpCardState(true, { state: 'failed' }).label).toBe('连接失败')
    expect(mcpCardState(true, { state: 'stopped' }).state).toBe('idle')
    expect(mcpCardState(true, null).label).toBe('未连接')
  })

  it('disabled wins over any connection state', () => {
    expect(mcpCardState(false, { state: 'ready' })).toEqual({
      state: 'disabled',
      label: '已停用',
      tone: 'neutral',
    })
  })
})

describe('buildMcpServerViews', () => {
  const config = {
    servers: {
      aihot: {
        transport: 'http',
        enabled: true,
        url: 'https://aihot.news/api/mcp?aihot_actor=[REDACTED]',
        headers: { Authorization: '[REDACTED]' },
      },
      'private-api': {
        transport: 'sse',
        enabled: true,
        url: 'https://mcp.example.test',
      },
      files: {
        transport: 'stdio',
        enabled: false,
        command: 'npx',
        args: ['[REDACTED]', '[REDACTED]'],
        env: { ROOT: '[REDACTED]' },
      },
    },
  }
  const status = {
    servers: [
      {
        serverName: 'aihot',
        state: 'ready',
        toolCount: 2,
        tools: ['get_hot_topics', 'search_news'],
      },
      {
        serverName: 'private-api',
        state: 'auth_failed',
        toolCount: 0,
        tools: [],
        lastError: {
          code: 'mcp_auth_failed',
          message: 'MCP server authentication failed',
        },
      },
    ],
  }
  const tools = [
    { name: 'read_file', description: 'Read a file', source: 'builtin' },
    {
      name: 'mcp_aihot_get_hot_topics',
      description: '获取热门话题',
      source: 'mcp',
      server: 'aihot',
    },
  ]

  it('joins config, status and tool descriptions per server', () => {
    const [aihot, privateApi, files] = buildMcpServerViews(
      config,
      status,
      tools,
    )
    expect(aihot).toMatchObject({
      name: 'aihot',
      transport: 'http',
      state: 'connected',
      toolCount: 2,
      target: 'https://aihot.news/api/mcp?aihot_actor=***',
      headerKeys: ['Authorization'],
      tools: [
        { name: 'get_hot_topics', description: '获取热门话题' },
        { name: 'search_news', description: '' },
      ],
    })
    expect(mcpServerSummary(aihot!)).toBe('已连接 · 2 个工具')

    expect(privateApi).toMatchObject({
      transport: 'sse',
      state: 'failed',
      stateLabel: '认证失败',
      toolCount: 0,
      lastError: {
        code: 'mcp_auth_failed',
        message: 'MCP server authentication failed',
      },
    })
    expect(mcpServerSummary(privateApi!)).toBe(
      '认证失败 · MCP server authentication failed',
    )
    expect(mcpServerFacts(privateApi!)).toContainEqual({
      key: 'error',
      term: '最近错误',
      value: 'MCP server authentication failed（mcp_auth_failed）',
    })

    expect(files).toMatchObject({
      transport: 'stdio',
      enabled: false,
      state: 'disabled',
      toolCount: 0,
      tools: [],
      target: 'npx *** ***',
      envKeys: ['ROOT'],
    })
  })

  it('lists stdio command + env keys and remote URL + header keys as facts', () => {
    const [aihot, , files] = buildMcpServerViews(config, status, tools)
    expect(mcpServerFacts(aihot!).map((item) => item.term)).toEqual([
      '传输',
      '地址',
      '请求头',
      '状态',
    ])
    expect(mcpServerFacts(files!)).toContainEqual({
      key: 'target',
      term: '命令',
      value: 'npx *** ***',
      mono: true,
    })
    expect(mcpServerFacts(files!)).toContainEqual({
      term: '环境变量',
      value: 'ROOT',
      mono: true,
    })
  })

  it('falls back to bootstrap tools when the status has no tool names', () => {
    const [view] = buildMcpServerViews(
      { servers: { aihot: { url: 'https://aihot.news/mcp' } } },
      { servers: [] },
      tools,
    )
    expect(view).toMatchObject({
      transport: 'http',
      state: 'idle',
      toolCount: 1,
      tools: [{ name: 'get_hot_topics', description: '获取热门话题' }],
    })
  })
})

describe('import preview rows', () => {
  const plan: McpImportPlanLike = {
    added: ['aihot'],
    updated: ['exa'],
    skipped: ['same'],
    warnings: ['server "same" 已存在且配置相同，未修改'],
    servers: [
      {
        name: 'aihot',
        transport: 'http',
        target: 'https://aihot.news/api/mcp?aihot_actor=[REDACTED]',
        action: 'add',
        conflict: false,
      },
      {
        name: 'exa',
        transport: 'http',
        target: 'https://mcp.exa.ai/mcp',
        action: 'update',
        conflict: true,
      },
      {
        name: 'same',
        transport: 'stdio',
        target: 'npx same',
        action: 'skip',
        conflict: true,
      },
    ],
  }

  it('turns overwritable conflicts into skip until 覆盖 is checked', () => {
    const rows = mcpPreviewRows(plan)
    expect(rows.map((row) => [row.name, row.kind, row.overwritable])).toEqual([
      ['aihot', 'add', false],
      ['exa', 'skip', true],
      ['same', 'same', false],
    ])
    expect(rows[0]!.target).toBe('https://aihot.news/api/mcp?aihot_actor=***')
    expect(mcpImportableCount(rows)).toBe(1)

    const chosen = mcpPreviewRows(plan, ['exa'])
    expect(chosen[1]).toMatchObject({ kind: 'update', overwrite: true })
    expect(mcpImportableCount(chosen)).toBe(2)
  })

  it('prunes overwrite names that are no longer overwritable', () => {
    expect(pruneOverwrite(plan, ['exa', 'same', 'gone'])).toEqual(['exa'])
    expect(pruneOverwrite(null, ['exa'])).toEqual([])
  })

  it('summarizes the real import for the toast', () => {
    expect(mcpImportSummary(plan)).toBe(
      '已导入 MCP 服务器：新增 1 个，更新 1 个，跳过 1 个',
    )
    expect(
      mcpImportSummary({ ...plan, added: [], updated: [], skipped: ['x'] }),
    ).toBe('没有写入任何 MCP 服务器（跳过 1 个）')
  })
})

describe('表单 → raw builder', () => {
  function form(patch: Partial<McpServerFormState>): McpServerFormState {
    return { ...emptyMcpServerForm(), ...patch }
  }

  it('builds a Claude-style mcpServers object for remote servers', () => {
    expect(
      buildMcpServerRaw(
        form({
          name: ' aihot ',
          transport: 'http',
          url: ' https://aihot.news/api/mcp?aihot_actor=abc ',
          headers: [
            { id: 1, key: 'Authorization', value: 'Bearer t' },
            { id: 2, key: '  ', value: 'ignored' },
          ],
        }),
      ),
    ).toEqual({
      mcpServers: {
        aihot: {
          type: 'http',
          url: 'https://aihot.news/api/mcp?aihot_actor=abc',
          headers: { Authorization: 'Bearer t' },
        },
      },
    })
    expect(
      buildMcpServerRaw(
        form({ name: 'legacy', transport: 'sse', url: 'http://x.test/sse' }),
      ),
    ).toEqual({
      mcpServers: { legacy: { type: 'sse', url: 'http://x.test/sse' } },
    })
  })

  it('splits a typed command line into command + args and keeps env', () => {
    expect(
      buildMcpServerRaw(
        form({
          name: 'fs',
          transport: 'stdio',
          command: 'npx -y @modelcontextprotocol/server-filesystem',
          args: '"/Users/me/My Docs" --read-only',
          env: [{ id: 1, key: 'DEBUG', value: '1' }],
        }),
      ),
    ).toEqual({
      mcpServers: {
        fs: {
          type: 'stdio',
          command: 'npx',
          args: [
            '-y',
            '@modelcontextprotocol/server-filesystem',
            '/Users/me/My Docs',
            '--read-only',
          ],
          env: { DEBUG: '1' },
        },
      },
    })
  })

  it('returns null with field errors while the form is invalid', () => {
    const invalid = form({ name: '-bad name', url: 'ftp://x' })
    expect(validateMcpServerForm(invalid)).toEqual({
      name: '只能包含字母、数字、- 和 _，且以字母或数字开头',
      url: '地址必须以 http:// 或 https:// 开头',
    })
    expect(buildMcpServerRaw(invalid)).toBeNull()
    expect(
      validateMcpServerForm(form({ name: '', transport: 'stdio' })),
    ).toEqual({ name: '请填写名称', command: '请填写启动命令' })
    expect(
      validateMcpServerForm(form({ name: 'env', url: '${MCP_URL}/mcp' })),
    ).toEqual({})
  })

  it('splits command lines like a shell', () => {
    expect(splitCommandLine(`a  'b c' "d \\"e\\"" f\\ g`)).toEqual([
      'a',
      'b c',
      'd "e"',
      'f g',
    ])
    expect(splitCommandLine('  ')).toEqual([])
    expect(splitCommandLine('""')).toEqual([''])
  })
})
