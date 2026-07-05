/**
 * ToolRegistry (MIG-TOOL-003)。
 * 对齐 Python `agent/tools/registry.py`：注册、生成 definitions、参数校验/转型、执行。
 */
import { ToolResultObj, type Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from './base'
import { ingestToolResultMedia } from '../media/ingest'
import { truncationNotice, ToolResultStore } from '../context/tool-results'

export class ToolRegistry {
  #tools = new Map<string, Tool>()
  #root = ''

  constructor(root = '') {
    this.#root = root
  }

  setRoot(root: string): void {
    this.#root = root
  }

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`)
    this.#tools.set(tool.name, tool)
  }

  unregisterWhere(predicate: (name: string, tool: Tool) => boolean): number {
    let removed = 0
    for (const [name, tool] of [...this.#tools.entries()]) {
      if (!predicate(name, tool)) continue
      this.#tools.delete(name)
      removed += 1
    }
    return removed
  }

  get(name: string): Tool | undefined { return this.#tools.get(name) }

  has(name: string): boolean { return this.#tools.has(name) }

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
  prepareCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const tool = this.#tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return castOne(args, tool.parameters as unknown as Record<string, unknown>) as Record<string, unknown>
  }

  /** 执行工具 + map_result，返回封顶后的字符串。对齐 `execute`。 */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    return (await this.executeResult(name, args)).modelContent
  }

  /** 执行工具 + map_result，返回富 ToolResult。对齐 Python `execute_result`。 */
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
      emit: ctx?.emit ?? null,
      loop: ctx?.loop ?? null,
      signal: ctx?.signal ?? null,
    }
    const raw = await tool.execute(casted, execCtx)
    let mapped: ToolResult
    if (typeof raw === 'string') {
      const capped = capText(raw, tool.maxResultChars)
      mapped = tool.mapResult(capped, execCtx)
      // 约定：字符串结果以 'Error:' 开头即失败（与 execution.coerceToolResult 一致）。
      // 默认 mapResult 不设 isError，缺了这步 deny/非零退出会被当成 tool_run_completed（B4.3 实测）。
      if (!mapped.isError && capped.startsWith('Error:')) mapped = { ...mapped, isError: true }
      if (capped !== raw) attachFullOutputRef(mapped, execCtx, name, raw)
    } else {
      mapped = capToolResult(raw, tool.maxResultChars)
      if (raw.modelContent.length > tool.maxResultChars) attachFullOutputRef(mapped, execCtx, name, raw.rawContent || raw.modelContent)
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

/** 截断即落盘：完整输出内容寻址存入 tool-result store，metadata 带回可回看 ref。持久化失败不阻塞结果。 */
function attachFullOutputRef(mapped: ToolResult, execCtx: ToolExecutionContext, toolName: string, fullText: string): void {
  try {
    const store = new ToolResultStore(execCtx.root)
    const record = store.persistLargeResult(
      String(execCtx.turnId || 'unknown_turn'),
      String(execCtx.parentCallId || 'unknown_call'),
      toolName,
      fullText,
    )
    mapped.metadata = { ...(mapped.metadata ?? {}), full_output_ref: record.artifact_path }
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
    displaySummary: result.displaySummary.length > limit
      ? capText(result.displaySummary, limit)
      : result.displaySummary,
  }
}

const BOOL_TRUE = new Set(['true', '1', 'yes', 'on'])
const BOOL_FALSE = new Set(['false', '0', 'no', 'off'])

/** 递归参数转型。对齐 Python `agent/tools/base.py:_cast_one`：未知类型原样返回。 */
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

  if (t === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k in props ? castOne(v, props[k]!) : v
    }
    return out
  }

  return value
}
