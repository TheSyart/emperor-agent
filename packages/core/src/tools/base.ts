/**
 * Tool 基类 + 能力声明 + ToolResult。
 */
import type { ToolParamsSchema } from './schema'
import type { ExecutionEnvironment } from '../environment/snapshot'
import type { HostExecutionAuthorization } from '../environment/process-runner'
import type {
  FileAccessAuthorization,
  FileExecutionScope,
} from '../permissions/workspace-policy'

export type ToolEvidencePolicy = 'eligible' | 'context_only' | 'forbidden'

export type ToolCapabilityProvenance =
  | { readonly kind: 'core_builtin' }
  | {
      readonly kind: 'external_transport'
      readonly transport: string
      readonly source: string
    }
  | {
      readonly kind: 'mcp_declaration'
      readonly serverName: string
      readonly toolName: string
      readonly transport: string
      readonly readOnlySource:
        'tool_override' | 'config_default' | 'fallback_write'
      readonly exclusiveSource:
        'tool_override' | 'config_default' | 'fallback_serialized'
      readonly generation: number | null
      readonly clientId: string | null
    }

export interface ToolCapabilityDescriptor {
  readonly version: 1
  readonly toolName: string
  readonly readMode: 'static_read_only' | 'argument_dependent' | 'mutating'
  readonly mutationScope:
    | 'none'
    | 'conditional'
    | 'workspace'
    | 'domain'
    | 'external'
    | 'domain_or_external'
  readonly concurrency: 'exclusive' | 'safe' | 'serialized'
  readonly requiresRuntimeContext: boolean
  readonly pathAccess:
    'none' | 'single' | 'multiple' | 'managed' | 'workspace_wide'
  readonly evidencePolicy: ToolEvidencePolicy
  readonly externalContent: boolean
  readonly provenance: ToolCapabilityProvenance
}

export interface ManageSkillPathCapability {
  readonly version: 1
  readonly toolName: 'manage_skill'
  readonly issuer: 'core_tool_host'
  readonly issuerId: string
  readonly rootDigest: string
  readonly action: 'create' | 'validate' | 'package'
  readonly relativeTarget: string
  readonly operationFingerprint: string
}

export interface InstallSkillPathCapability {
  readonly version: 1
  readonly toolName: 'install_skill'
  readonly issuer: 'core_tool_host'
  readonly issuerId: string
  readonly rootDigest: string
  readonly action: 'preview' | 'confirm'
  readonly relativeTarget: string
  readonly operationFingerprint: string
}

export interface ManageEnvironmentPathCapability {
  readonly version: 1
  readonly toolName: 'manage_environment'
  readonly issuer: 'core_tool_host'
  readonly issuerId: string
  readonly rootDigest: string
  readonly action: 'status' | 'preview_install' | 'confirm_install' | 'cancel'
  readonly relativeTarget: string
  readonly operationFingerprint: string
}

export type ManagedPathCapability =
  | ManageSkillPathCapability
  | InstallSkillPathCapability
  | ManageEnvironmentPathCapability

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

export type ToolOutcome = 'success' | 'failure' | 'followup_required'
export type ToolProgressDisposition =
  'none' | 'discovery' | 'execution' | 'verified'
export type ToolEvidenceDisposition = 'none' | 'candidate' | 'verified'
export type ToolWorkspaceEffect = 'none' | 'known_paths' | 'unattributed'

export interface ToolOutcomeMetadata {
  outcome: ToolOutcome
  failure_kind?: string
  retryable?: boolean
  strategy_key?: string
  http_status?: number
  evidence?: unknown
  success_scope?: string
  progress?: ToolProgressDisposition
  evidence_disposition?: ToolEvidenceDisposition
  workspace_effect?: ToolWorkspaceEffect
  verification_required?: boolean
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
 * 富工具结果对象（runner/engine 共用）。
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
    this.isError = data.isError ?? false
    const metadata = data.metadata ?? {}
    this.metadata = {
      ...metadata,
      outcome:
        metadata.outcome === 'followup_required'
          ? 'followup_required'
          : this.isError
            ? 'failure'
            : 'success',
    }
  }

  /** displaySummary 优先，回退 modelContent。 */
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

  /** 转换为可序列化的 artifact payload。 */
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
  /** Trusted runner decision; never populated from model tool arguments. */
  processExecution?:
    | { kind: 'sandbox' }
    | { kind: 'host'; authorization: HostExecutionAuthorization }
  /** Host-issued authority for a non-workspace managed root; never model input. */
  managedPathCapability?: ManagedPathCapability
  /** Host-issued authority for one ordinary user Skill subtree. */
  fileExecutionScopes?: readonly FileExecutionScope[]
  /** Exact host-issued authority for external reads; never model input. */
  fileAccessAuthorization?: FileAccessAuthorization | null
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
  domainStateMutation = false
  evidencePolicy: ToolEvidencePolicy = 'context_only'
  classifiesStringErrors = false
  externalContent = false
  capabilityProvenance: ToolCapabilityProvenance = { kind: 'core_builtin' }

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
  /** Called only by the trusted Runner after Hook transforms and permission checks. */
  issueManagedPathCapability?(
    args: Record<string, unknown>,
  ): ManagedPathCapability

  abstract execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> | ToolExecutionResult

  /** 可选：把原始输出映射为 ToolResult。默认包成 okResult。 */
  mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return okResult(raw, { meta: { tool: this.name } })
  }

  capabilityDescriptor(): ToolCapabilityDescriptor {
    const argumentDependent = this.isReadOnly !== Tool.prototype.isReadOnly
    const readMode = argumentDependent
      ? 'argument_dependent'
      : this.readOnly
        ? 'static_read_only'
        : 'mutating'
    const pathAccess = this.getPaths
      ? 'multiple'
      : this.getPath
        ? 'single'
        : this.issueManagedPathCapability
          ? 'managed'
          : this.workspaceMutation
            ? 'workspace_wide'
            : 'none'
    return {
      version: 1,
      toolName: this.name,
      readMode,
      mutationScope: this.workspaceMutation
        ? 'workspace'
        : this.domainStateMutation
          ? 'domain'
          : readMode === 'static_read_only'
            ? 'none'
            : readMode === 'argument_dependent'
              ? 'conditional'
              : this.capabilityProvenance.kind === 'core_builtin'
                ? 'domain_or_external'
                : 'external',
      concurrency: this.exclusive
        ? 'exclusive'
        : this.concurrencySafe
          ? 'safe'
          : 'serialized',
      requiresRuntimeContext: this.requiresRuntimeContext,
      pathAccess,
      evidencePolicy: this.evidencePolicy,
      externalContent: this.externalContent,
      provenance: structuredClone(this.capabilityProvenance),
    }
  }

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.parameters,
    }
  }
}
