import { describe, expect, it } from 'vitest'
import type { ToolInfo } from '../../../types'
import {
  groupTools,
  toolMatches,
  toolParams,
  toolSchemaText,
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

  it('groups built-in tools first, then one group per MCP server', () => {
    const groups = groupTools([
      tool({ name: 'mcp_z_a', source: 'mcp', server: 'zeta' }),
      tool({ name: 'read_file', source: 'builtin' }),
      tool({ name: 'mcp_a_b', source: 'mcp', server: 'alpha' }),
      tool({ name: 'run_command' }),
    ])
    expect(groups.map((group) => [group.title, group.tools.length])).toEqual([
      ['内建工具', 2],
      ['MCP · alpha', 1],
      ['MCP · zeta', 1],
    ])
  })
})
