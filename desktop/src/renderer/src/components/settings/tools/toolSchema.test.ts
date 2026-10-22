import { describe, expect, it } from 'vitest'
import type { ToolInfo } from '../../../types'
import {
  groupTools,
  isBuiltinTool,
  toolMatches,
  toolParams,
  toolSchemaText,
  toolSummary,
} from './toolSchema'

const schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径' },
    lines: { type: 'array', items: { type: 'integer' } },
    mode: { type: 'string', enum: ['fast', 'full'] },
    target: { type: ['string', 'null'] },
    either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    loose: {},
  },
  required: ['path', 'mode'],
}

function tool(patch: Partial<ToolInfo>): ToolInfo {
  return { name: 'read_file', description: 'Read a file', ...patch }
}

describe('tool schema helpers', () => {
  it('reads parameter rows with types, required flags and enum values', () => {
    expect(toolParams(schema)).toEqual([
      {
        name: 'path',
        type: 'string',
        required: true,
        description: '文件路径',
        values: [],
      },
      {
        name: 'lines',
        type: 'integer[]',
        required: false,
        description: '',
        values: [],
      },
      {
        name: 'mode',
        type: 'enum',
        required: true,
        description: '',
        values: ['fast', 'full'],
      },
      {
        name: 'target',
        type: 'string | null',
        required: false,
        description: '',
        values: [],
      },
      {
        name: 'either',
        type: 'string | number',
        required: false,
        description: '',
        values: [],
      },
      {
        name: 'loose',
        type: 'any',
        required: false,
        description: '',
        values: [],
      },
    ])
    expect(toolParams(undefined)).toEqual([])
    expect(toolParams({ type: 'object' })).toEqual([])
  })

  it('pretty-prints the schema and falls back to {}', () => {
    expect(toolSchemaText(undefined)).toBe('{}')
    expect(toolSchemaText({})).toBe('{}')
    expect(toolSchemaText({ type: 'object' })).toBe('{\n  "type": "object"\n}')
  })

  it('matches by name, description and MCP server', () => {
    const mcp = tool({
      name: 'mcp_github_search',
      source: 'mcp',
      server: 'github',
    })
    expect(toolMatches(mcp, 'GitHub')).toBe(true)
    expect(toolMatches(tool({}), 'read a')).toBe(true)
    expect(toolMatches(tool({}), 'write')).toBe(false)
    expect(toolMatches(tool({}), '  ')).toBe(true)
  })

  it('groups tools by category in page order, uncategorized ones last', () => {
    const groups = groupTools([
      tool({ name: 'skill', category: 'config' }),
      tool({ name: 'bash', category: 'basic' }),
      tool({ name: 'mystery' }),
      tool({ name: 'subagent', category: 'agents' }),
      tool({ name: 'read', category: 'basic' }),
      tool({ name: 'todo_write', category: 'planning' }),
      tool({ name: 'web_search', category: 'network' }),
      tool({ name: 'newer', category: 'later' as never }),
    ])
    expect(
      groups.map((group) => [
        group.id,
        group.title,
        group.tools.map((item) => item.name),
      ]),
    ).toEqual([
      ['basic', '基础工具', ['bash', 'read']],
      ['network', '网络', ['web_search']],
      ['planning', '任务与规划', ['todo_write']],
      ['agents', '子智能体与工作流', ['subagent']],
      ['config', '技能、记忆与配置', ['skill']],
      ['other', '其他', ['mystery', 'newer']],
    ])
    // Empty categories are left out.
    expect(
      groupTools([tool({ name: 'read', category: 'basic' })]).map(
        (group) => group.id,
      ),
    ).toEqual(['basic'])
  })

  it('keeps only Emperor’s own tools: no MCP server’s, no plugin’s', () => {
    expect(isBuiltinTool(tool({ source: 'builtin', category: 'basic' }))).toBe(
      true,
    )
    expect(isBuiltinTool(tool({}))).toBe(true)
    expect(
      isBuiltinTool(tool({ name: 'mcp_a_b', source: 'mcp', server: 'a' })),
    ).toBe(false)
    expect(
      isBuiltinTool(
        tool({
          name: 'browser_open',
          source: 'builtin',
          plugin_id: 'computer-use',
        }),
      ),
    ).toBe(false)
  })

  it('says what a tool does in its first sentence', () => {
    expect(
      toolSummary(
        'Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell.',
      ),
    ).toBe('Execute a bash command (`bash -c`) and return its stdout/stderr.')
    expect(toolSummary('Read a UTF-8 text file.')).toBe(
      'Read a UTF-8 text file.',
    )
    expect(
      toolSummary(
        'Press a key or key combination, e.g. Enter, Tab, Escape. Then observe.',
      ),
    ).toBe('Press a key or key combination, e.g. Enter, Tab, Escape.')
    expect(
      toolSummary(
        '管理本地持久定时任务：查看、创建或删除。只读检查使用 list。',
      ),
    ).toBe('管理本地持久定时任务：查看、创建或删除。')
    expect(toolSummary('  No full stop  ')).toBe('No full stop')
    expect(toolSummary('')).toBe('')
  })
})
