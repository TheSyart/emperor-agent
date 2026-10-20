/**
 * 能力 › 工具 — pure helpers: which tools the page lists (Emperor's own, not
 * an MCP server's or a plugin's), filtering and grouping them by Core's
 * category, a tool's one-sentence summary, and its JSON-schema parameters
 * as display rows.
 */
import type { ToolCategory, ToolInfo } from '../../../types'

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
  id: ToolCategory | 'other'
  title: string
  tools: ToolInfo[]
}

/** The page's groups in order; a tool without a known category goes to 其他. */
export const TOOL_CATEGORY_GROUPS: ReadonlyArray<{
  id: ToolCategory
  title: string
}> = [
  { id: 'basic', title: '基础工具' },
  { id: 'network', title: '网络' },
  { id: 'planning', title: '任务与规划' },
  { id: 'agents', title: '子智能体与工作流' },
  { id: 'config', title: '技能、记忆与配置' },
]

type Schema = Record<string, unknown>

function isSchema(value: unknown): value is Schema {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The JSON Schema type expression (`string[]`, `enum`, `a | b`), shown as code. */
function schemaType(schema: Schema): string {
  if (Array.isArray(schema.enum)) return 'enum'
  const type = schema.type
  if (Array.isArray(type)) return type.map(String).join(' | ')
  if (type === 'array') {
    const items = isSchema(schema.items) ? schemaType(schema.items) : 'any'
    return `${items.includes(' ') ? `(${items})` : items}[]`
  }
  if (typeof type === 'string') return type
  const variants = (schema.anyOf ?? schema.oneOf) as unknown
  if (Array.isArray(variants))
    return variants
      .filter(isSchema)
      .map((variant) => schemaType(variant))
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
      type: schemaType(schema),
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

// A full stop that ends a sentence: not the one inside "e.g." or "i.e.".
const SENTENCE_END = /(?<!\b(?:e\.g|i\.e|etc|vs))[.!?](?=\s)|[。！？]/

/** The first sentence of a tool's description (the row's one-line summary). */
export function toolSummary(description: string): string {
  const text = description.trim()
  const end = SENTENCE_END.exec(text)
  return end ? text.slice(0, end.index + 1) : text
}

/** A tool Emperor itself registers: not an MCP server's, not a plugin's. */
export function isBuiltinTool(tool: ToolInfo): boolean {
  return tool.source !== 'mcp' && !tool.plugin_id
}

export function toolMatches(tool: ToolInfo, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${tool.name} ${tool.description ?? ''} ${tool.server ?? ''}`
    .toLowerCase()
    .includes(needle)
}

/** Tools by category in page order, then 其他; empty groups are left out. */
export function groupTools(tools: readonly ToolInfo[]): ToolGroup[] {
  const known = new Set<string>(TOOL_CATEGORY_GROUPS.map((group) => group.id))
  const groups: ToolGroup[] = TOOL_CATEGORY_GROUPS.map((group) => ({
    ...group,
    tools: tools.filter((tool) => tool.category === group.id),
  }))
  groups.push({
    id: 'other',
    title: '其他',
    tools: tools.filter((tool) => !tool.category || !known.has(tool.category)),
  })
  return groups.filter((group) => group.tools.length > 0)
}
