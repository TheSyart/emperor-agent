/**
 * ToolRegistry：注册、能力声明校验、definition 生成、参数转型与执行。
 */
import {
  isToolErrorText,
  ToolResultObj,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolCapabilityDescriptor,
  type ToolResult,
} from './base'
import { ingestToolResultMedia } from '../media/ingest'
import { truncationNotice, ToolResultStore } from '../context/tool-results'

export class ToolRegistry {
  #tools = new Map<string, Tool>()
  #capabilities = new Map<string, ToolCapabilityDescriptor>()
  #root = ''

  constructor(root = '') {
    this.#root = root
  }

  setRoot(root: string): void {
    this.#root = root
  }

  register(tool: Tool): void {
    if (this.#tools.has(tool.name))
      throw new Error(`Tool "${tool.name}" is already registered`)
    const descriptor = tool.capabilityDescriptor()
    assertToolCapabilityDescriptor(tool, descriptor)
    this.#tools.set(tool.name, tool)
    this.#capabilities.set(tool.name, descriptor)
  }

  unregisterWhere(predicate: (name: string, tool: Tool) => boolean): number {
    let removed = 0
    for (const [name, tool] of [...this.#tools.entries()]) {
      if (!predicate(name, tool)) continue
      this.#tools.delete(name)
      this.#capabilities.delete(name)
      removed += 1
    }
    return removed
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }

  has(name: string): boolean {
    return this.#tools.has(name)
  }

  getCapabilityDescriptor(name: string): ToolCapabilityDescriptor | undefined {
    const descriptor = this.#capabilities.get(name)
    return descriptor ? structuredClone(descriptor) : undefined
  }

  getCapabilityDescriptors(): ToolCapabilityDescriptor[] {
    return [...this.#capabilities.values()]
      .sort((left, right) => left.toolName.localeCompare(right.toolName))
      .map((descriptor) => structuredClone(descriptor))
  }

  /** builtin 在前，mcp_ 在后。对齐 `get_definitions`。 */
  getDefinitions(): ToolDefinition[] {
    const builtin: ToolDefinition[] = []
    const mcp: ToolDefinition[] = []
    for (const name of [...this.#tools.keys()].sort()) {
      const d = this.#tools.get(name)!.definition()
      ;(name.startsWith('mcp_') ? mcp : builtin).push(d)
    }
    return builtin.concat(mcp)
  }

  /** 参数转型 + 类型校验。对齐 `prepare_call` → `cast_params`。 */
  prepareCall(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const tool = this.#tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const prepared = castOne(
      args,
      tool.parameters as unknown as Record<string, unknown>,
    ) as Record<string, unknown>
    const error = validateValue(
      prepared,
      tool.parameters as unknown as Record<string, unknown>,
      'arguments',
    )
    if (error)
      throw new Error(`Tool schema validation failed for ${name}: ${error}`)
    return prepared
  }

  /** 执行工具 + map_result，返回封顶后的字符串。对齐 `execute`。 */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    return (await this.executeResult(name, args)).modelContent
  }

  /** 执行工具 + map_result，返回富 ToolResult。 */
  async executeResult(
    name: string,
    args: Record<string, unknown>,
    ctx?: Partial<ToolExecutionContext>,
  ): Promise<ToolResultObj> {
    const tool = this.#tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const casted = this.prepareCall(name, args)
    const execCtx: ToolExecutionContext = {
      root: ctx?.root ?? this.#root,
      workspaceRoot: ctx?.workspaceRoot ?? ctx?.root ?? this.#root,
      arguments: casted,
      turnId: ctx?.turnId ?? null,
      parentCallId: ctx?.parentCallId ?? null,
      sessionId: ctx?.sessionId ?? null,
      taskId: ctx?.taskId ?? null,
      emit: ctx?.emit ?? null,
      loop: ctx?.loop ?? null,
      signal: ctx?.signal ?? null,
      executionEnvironment: ctx?.executionEnvironment ?? null,
      subagentDepth: ctx?.subagentDepth ?? 0,
      parentContext: ctx?.parentContext,
      parentSystemPrompt: ctx?.parentSystemPrompt ?? null,
      processExecution: ctx?.processExecution,
      managedPathCapability: ctx?.managedPathCapability,
      fileExecutionScopes: ctx?.fileExecutionScopes,
      fileAccessAuthorization: ctx?.fileAccessAuthorization,
    }
    const raw = await tool.execute(casted, execCtx)
    let mapped: ToolResult
    if (typeof raw === 'string') {
      const capped = capText(raw, tool.maxResultChars)
      mapped = tool.mapResult(capped, execCtx)
      // 约定：内建字符串错误前缀统一标为失败（与 execution.coerceToolResult 一致）。
      // 默认 mapResult 不设 isError，缺了这步会被当成 tool_run_completed。
      if (
        !mapped.isError &&
        !tool.classifiesStringErrors &&
        isToolErrorText(capped)
      )
        mapped = { ...mapped, isError: true }
      if (capped !== raw)
        attachFullOutputRef(mapped, execCtx, name, raw, tool.maxResultChars)
    } else {
      mapped = capToolResult(raw, tool.maxResultChars)
      if (
        raw.modelContent.length > tool.maxResultChars ||
        raw.rawContent.length > tool.maxResultChars
      )
        attachFullOutputRef(
          mapped,
          execCtx,
          name,
          raw.rawContent || raw.modelContent,
          tool.maxResultChars,
        )
    }
    return ingestToolResultMedia(ToolResultObj.fromData(mapped), {
      root: execCtx.root,
      workspaceRoot: execCtx.workspaceRoot,
      toolName: name,
      arguments: casted,
      turnId: execCtx.turnId,
      toolCallId: execCtx.parentCallId,
    })
  }

  /** 每工具结果上限，供 ContextPipeline 用。对齐 `tool_result_limits`。 */
  toolResultLimits(): Record<string, number> {
    const limits: Record<string, number> = {}
    for (const [name, tool] of this.#tools) limits[name] = tool.maxResultChars
    return limits
  }
}

function assertToolCapabilityDescriptor(
  tool: Tool,
  descriptor: ToolCapabilityDescriptor,
): void {
  if (descriptor.toolName !== tool.name)
    throw new Error(`Tool capability name mismatch for ${tool.name}`)
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool.name))
    throw new Error(`Tool capability name is invalid: ${tool.name}`)
  if (!tool.description.trim())
    throw new Error(`Tool capability description is empty: ${tool.name}`)
  if (tool.exclusive && tool.concurrencySafe)
    throw new Error(
      `Tool capability conflict for ${tool.name}: exclusive and concurrencySafe cannot both be true`,
    )
  if (tool.readOnly && tool.workspaceMutation)
    throw new Error(
      `Tool capability conflict for ${tool.name}: readOnly and workspaceMutation cannot both be true`,
    )
  if (tool.workspaceMutation && tool.domainStateMutation)
    throw new Error(
      `Tool capability conflict for ${tool.name}: workspaceMutation and domainStateMutation cannot both be true`,
    )
  if (tool.workspaceMutation && tool.concurrencySafe)
    throw new Error(
      `Tool capability conflict for ${tool.name}: workspaceMutation cannot be concurrencySafe`,
    )
  if (
    descriptor.externalContent &&
    descriptor.evidencePolicy !== 'context_only'
  )
    throw new Error(
      `Tool capability conflict for ${tool.name}: external content must default to context_only evidence`,
    )
  if (tool.name.startsWith('mcp_')) {
    if (descriptor.provenance.kind !== 'mcp_declaration')
      throw new Error(
        `MCP tool capability provenance is required for ${tool.name}`,
      )
    if (!descriptor.externalContent)
      throw new Error(`MCP tool must declare external content: ${tool.name}`)
    if (
      descriptor.provenance.generation !== null &&
      (!Number.isSafeInteger(descriptor.provenance.generation) ||
        descriptor.provenance.generation < 1)
    )
      throw new Error(`MCP tool generation is invalid for ${tool.name}`)
  }
  if (
    descriptor.externalContent !==
    (descriptor.provenance.kind !== 'core_builtin')
  )
    throw new Error(
      `Tool capability conflict for ${tool.name}: external content provenance is inconsistent`,
    )
}

/** 截断即落盘：完整输出内容寻址存入 tool-result store，metadata 带回可回看 ref。持久化失败不阻塞结果。 */
function attachFullOutputRef(
  mapped: ToolResult,
  execCtx: ToolExecutionContext,
  toolName: string,
  fullText: string,
  maxChars: number,
): void {
  try {
    const store = new ToolResultStore(execCtx.root, {
      sessionId: execCtx.sessionId,
    })
    const record = store.persistLargeResult(
      String(execCtx.turnId || 'unknown_turn'),
      String(execCtx.parentCallId || 'unknown_call'),
      toolName,
      fullText,
    )
    mapped.metadata = {
      ...(mapped.metadata ?? {}),
      full_output_ref: record.artifact_path,
    }
    const notice =
      `\n${truncationNotice(fullText.length)}\n\n` +
      `Full output saved to: ${record.artifact_path}\n` +
      'Use read_file with this absolute path if the exact output is required.'
    const budget = Math.max(0, maxChars - notice.length)
    mapped.modelContent = `${mapped.modelContent.slice(0, budget)}${notice}`
  } catch {
    // 落盘失败时保持原截断行为
  }
}

function capText(text: string, limit: number): string {
  return text.length > limit
    ? text.slice(0, limit - 200) + `\n${truncationNotice(text.length)}`
    : text
}

function capToolResult(result: ToolResult, limit: number): ToolResult {
  const modelContent = capText(result.modelContent, limit)
  const rawContent = capText(result.rawContent, limit)
  return {
    ...result,
    modelContent,
    rawContent,
    displaySummary:
      result.displaySummary.length > limit
        ? capText(result.displaySummary, limit)
        : result.displaySummary,
  }
}

const BOOL_TRUE = new Set(['true', '1', 'yes', 'on'])
const BOOL_FALSE = new Set(['false', '0', 'no', 'off'])

/** 递归参数转型；未知类型原样返回。 */
function castOne(value: unknown, schema: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return value
  let t = schema.type as string | string[] | undefined
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null')
    t = nonNull.length ? nonNull[0] : undefined
  }

  if (t === 'integer') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const n = Number.parseInt(value, 10)
      return Number.isNaN(n) || !/^[+-]?\d+$/.test(value.trim()) ? value : n
    }
    if (typeof value === 'number' && Number.isInteger(value)) return value
    return value
  }

  if (t === 'number') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const n = Number.parseFloat(value)
      return Number.isNaN(n) ? value : n
    }
    return value
  }

  if (t === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase()
      if (BOOL_TRUE.has(v)) return true
      if (BOOL_FALSE.has(v)) return false
    }
    return value
  }

  if (t === 'array' && Array.isArray(value)) {
    const itemSchema = (schema.items as Record<string, unknown>) ?? {}
    return value.map((v) => castOne(v, itemSchema))
  }

  if (
    t === 'object' &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const props =
      (schema.properties as Record<string, Record<string, unknown>>) ?? {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k in props ? castOne(v, props[k]!) : v
    }
    return out
  }

  return value
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | null {
  const type = schema.type
  if (Array.isArray(type)) {
    const matches = type.some((candidate) =>
      candidate === 'null'
        ? value === null
        : candidate === 'string'
          ? typeof value === 'string'
          : candidate === 'boolean'
            ? typeof value === 'boolean'
            : candidate === 'integer'
              ? typeof value === 'number' && Number.isInteger(value)
              : candidate === 'number'
                ? typeof value === 'number'
                : false,
    )
    return matches ? null : `${path} must match one of: ${type.join(', ')}`
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return `${path} must be an object`
    const record = value as Record<string, unknown>
    const required = Array.isArray(schema.required)
      ? schema.required.map(String)
      : []
    for (const name of required) {
      if (
        !(name in record) ||
        record[name] === undefined ||
        record[name] === null
      )
        return `${path}.${name} is required`
    }
    const properties =
      schema.properties &&
      typeof schema.properties === 'object' &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {}
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(record)) {
        if (!(name in properties)) return `${path} has unknown field ${name}`
      }
    }
    for (const [name, childSchema] of Object.entries(properties)) {
      if (
        !(name in record) ||
        record[name] === undefined ||
        record[name] === null
      )
        continue
      const childError = validateValue(
        record[name],
        childSchema,
        `${path}.${name}`,
      )
      if (childError) return childError
    }
    return null
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`
    const itemSchema =
      schema.items && typeof schema.items === 'object'
        ? (schema.items as Record<string, unknown>)
        : {}
    for (let index = 0; index < value.length; index++) {
      const itemError = validateValue(
        value[index],
        itemSchema,
        `${path}[${index}]`,
      )
      if (itemError) return itemError
    }
    return null
  }
  if (type === 'string' && typeof value !== 'string')
    return `${path} must be a string`
  if (type === 'boolean' && typeof value !== 'boolean')
    return `${path} must be a boolean`
  if (type === 'number' && typeof value !== 'number')
    return `${path} must be a number`
  if (
    type === 'integer' &&
    (typeof value !== 'number' || !Number.isInteger(value))
  )
    return `${path} must be an integer`
  return null
}
