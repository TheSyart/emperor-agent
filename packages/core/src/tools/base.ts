/**
 * Tool 基类 + 能力标志 + ToolResult (MIG-TOOL-001/002)。
 * 对齐 Python `agent/tools/base.py` + `results.py` + `protocol.py`。
 */
import type { ToolParamsSchema } from './schema'
import type { ExecutionEnvironment } from '../environment/snapshot'

export type ToolEvidencePolicy = 'eligible' | 'context_only' | 'forbidden'

// ── results ──

export interface ToolArtifact {
  path: string
  kind: string
  bytes: number
  media?: ToolArtifactMedia
  metadata: Record<string, unknown>
}

export interface ToolArtifactMedia {
  id: string
  kind: 'image' | 'audio'
  mime: string
  name: string
  relPath: string
  originalPath: string
}

export interface ToolResult {
  modelContent: string
  displaySummary: string
  rawContent: string
  artifacts: ToolArtifact[]
  metadata: Record<string, unknown>
  isError: boolean
}

export type ToolExecutionResult = string | ToolResult

export function okResult(
  content: string,
  opts?: { summary?: string; meta?: Record<string, unknown> },
): ToolResult {
  return {
    modelContent: content,
    displaySummary: opts?.summary ?? content.slice(0, 120),
    rawContent: content,
    artifacts: [],
    metadata: opts?.meta ?? {},
    isError: false,
  }
}

export function errResult(
  content: string,
  opts?: { meta?: Record<string, unknown> },
): ToolResult {
  return { ...okResult(content, opts), isError: true }
}

/** Conventional string error forms returned by legacy and rich built-in tools. */
export function isToolErrorText(value: unknown): boolean {
  const text = String(value ?? '')
  return (
    text.startsWith('Error:') ||
    text.startsWith('[ERR]') ||
    /^Error \(exit \d+\):/.test(text)
  )
}

/**
 * 富工具结果对象 (MIG-TOOL-002，runner/engine 用)。对齐 Python `agent/tools/results.py:ToolResult`。
 * 暴露 modelContent/summary/displaySummary/metadata/artifacts/isError 与 fromText/artifactPayloads。
 */
export class ToolResultObj {
  modelContent: string
  displaySummary: string
  rawContent: string
  artifacts: ToolArtifact[]
  metadata: Record<string, unknown>
  isError: boolean

  constructor(data: Partial<ToolResult> & { modelContent: string }) {
    this.modelContent = data.modelContent
    this.displaySummary = data.displaySummary ?? data.modelContent.slice(0, 120)
    this.rawContent = data.rawContent ?? data.modelContent
    this.artifacts = data.artifacts ?? []
    this.metadata = data.metadata ?? {}
    this.isError = data.isError ?? false
  }

  /** Python `ToolResult.summary` —— displaySummary 优先，回退 modelContent。 */
  get summary(): string {
    return this.displaySummary || this.modelContent
  }

  static fromText(
    text: string,
    opts?: { isError?: boolean; meta?: Record<string, unknown> },
  ): ToolResultObj {
    return new ToolResultObj({
      modelContent: text,
      displaySummary: text.slice(0, 120),
      metadata: opts?.meta ?? {},
      isError: opts?.isError ?? false,
    })
  }

  static fromData(data: ToolResult): ToolResultObj {
    return new ToolResultObj(data)
  }

  /** 对齐 Python `artifact_payloads()`。 */
  artifactPayloads(): Array<Record<string, unknown>> {
    return this.artifacts.map((a) => ({
      path: a.path,
      kind: a.kind,
      bytes: a.bytes,
      ...(a.media ? { media: a.media } : {}),
      metadata: a.metadata,
    }))
  }
}

// ── execution context ──

export interface ToolExecutionContext {
  root: string
  workspaceRoot?: string | null
  arguments: Record<string, unknown>
  turnId?: string | null
  parentCallId?: string | null
  sessionId?: string | null
  taskId?: string | null
  executionEnvironment?: ExecutionEnvironment | null
  /** 运行时事件发射器（流式事件 dict）。对齐 runner/control 的 StreamEmitter。 */
  emit?: ((event: Record<string, unknown>) => void | Promise<void>) | null
  loop?: unknown | null
  signal?: AbortSignal | null
  /** Subagent supervisor depth; main turns are 0 and children cannot exceed 1. */
  subagentDepth?: number
  /** Normalized parent conversation used only by an explicit fork subagent. */
  parentContext?: Array<Record<string, unknown>>
  /** Stable parent system contract inherited only by an explicit fork. */
  parentSystemPrompt?: string | null
}

// ── tool base ──

/** Tool definition as given to the LLM. */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: ToolParamsSchema
}

export abstract class Tool {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly parameters: ToolParamsSchema

  readOnly = false
  exclusive = false
  requiresRuntimeContext = false
  maxResultChars = 12_000
  concurrencySafe = false
  workspaceMutation = false
  evidencePolicy: ToolEvidencePolicy = 'context_only'
  classifiesStringErrors = false

  /** 子类可覆写以提供运行时参数感知的只读判定。对齐 `is_read_only(arguments)`。 */
  isReadOnly(_args: Record<string, unknown>): boolean {
    return this.readOnly
  }

  isDestructive(args?: Record<string, unknown>): boolean {
    return !this.isReadOnly(args ?? {})
  }

  isConcurrencySafe(_args?: Record<string, unknown>): boolean {
    return this.concurrencySafe && !this.exclusive
  }

  /** Only direct local workspace writers participate in the Git/workspace lease. */
  mutatesWorkspace(_args: Record<string, unknown>): boolean {
    return this.workspaceMutation
  }

  /** 可选：返回该调用影响的路径（供权限画像/敏感路径判定）。对齐 `get_path(arguments)`。 */
  getPath?(args: Record<string, unknown>): string | null
  /** 多路径 mutation 必须返回全部路径，权限规则不能只检查第一个参数。 */
  getPaths?(args: Record<string, unknown>): string[]

  abstract execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> | ToolExecutionResult

  /** 可选：把原始输出映射为 ToolResult。默认包成 okResult。 */
  mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return okResult(raw, { meta: { tool: this.name } })
  }

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.parameters,
    }
  }
}
