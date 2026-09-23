/**
 * 能力 › 工具 — pure helpers: filtering and grouping the registered tool
 * list (built-in first, then one group per MCP server) and reading a tool's
 * JSON-schema parameters into display rows.
 */
import type { ToolInfo } from '../../../types'

export interface ToolParam {
  name: string
  /** Short type label: `string`, `number[]`, `enum`, `string | null`… */
  type: string
  required: boolean
  description: string
  /** Allowed values of an enum parameter. */
  values: string[]
}

export interface ToolGroup {
  id: string
  title: string
  tools: ToolInfo[]
}

type Schema = Record<string, unknown>

function isSchema(value: unknown): value is Schema {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function typeLabel(schema: Schema): string {
  if (Array.isArray(schema.enum)) return 'enum'
  const type = schema.type
  if (Array.isArray(type)) return type.map(String).join(' | ')
  if (type === 'array') {
    const items = isSchema(schema.items) ? typeLabel(schema.items) : 'any'
    return `${items.includes(' ') ? `(${items})` : items}[]`
  }
  if (typeof type === 'string') return type
  const variants = (schema.anyOf ?? schema.oneOf) as unknown
  if (Array.isArray(variants))
    return variants
      .filter(isSchema)
      .map((variant) => typeLabel(variant))
      .join(' | ')
  return 'any'
}

/** Parameter rows of a tool's JSON schema (declaration order). */
export function toolParams(parameters?: Record<string, unknown>): ToolParam[] {
  if (!isSchema(parameters) || !isSchema(parameters.properties)) return []
  const required = new Set(
    Array.isArray(parameters.required) ? parameters.required.map(String) : [],
  )
  return Object.entries(parameters.properties).map(([name, raw]) => {
    const schema = isSchema(raw) ? raw : {}
    return {
      name,
      type: typeLabel(schema),
      required: required.has(name),
      description:
        typeof schema.description === 'string' ? schema.description : '',
      values: Array.isArray(schema.enum) ? schema.enum.map(String) : [],
    }
  })
}

/** Pretty-printed schema text (`{}` when the tool declares none). */
export function toolSchemaText(parameters?: Record<string, unknown>): string {
  if (!isSchema(parameters) || !Object.keys(parameters).length) return '{}'
  return JSON.stringify(parameters, null, 2)
}

export function toolMatches(tool: ToolInfo, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${tool.name} ${tool.description ?? ''} ${tool.server ?? ''}`
    .toLowerCase()
    .includes(needle)
}

/** Built-in tools first, then one group per MCP server (name order). */
export function groupTools(tools: readonly ToolInfo[]): ToolGroup[] {
  const builtin: ToolInfo[] = []
  const servers = new Map<string, ToolInfo[]>()
  for (const tool of tools) {
    if (tool.source === 'mcp') {
      const server = tool.server || 'MCP'
      servers.set(server, [...(servers.get(server) ?? []), tool])
    } else builtin.push(tool)
  }
  const groups: ToolGroup[] = []
  if (builtin.length)
    groups.push({ id: 'builtin', title: '内建工具', tools: builtin })
  for (const server of [...servers.keys()].sort((a, b) => a.localeCompare(b)))
    groups.push({
      id: `mcp:${server}`,
      title: `MCP · ${server}`,
      tools: servers.get(server) ?? [],
    })
  return groups
}
