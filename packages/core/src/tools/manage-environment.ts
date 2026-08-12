import { createHash, randomBytes } from 'node:crypto'
import type {
  ManagedEnvironmentInstallPreview,
  ManagedEnvironmentInstallResult,
} from '../environment/managed'
import type { ExecutionEnvironment } from '../environment/snapshot'
import {
  Tool,
  errResult,
  okResult,
  type ManageEnvironmentPathCapability,
  type ManagedPathCapability,
  type ToolCapabilityProvenance,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from './base'
import type { ToolParamsSchema } from './schema'

export interface NativeEnvironmentInstallHost {
  status(): Promise<unknown>
  previewInstall(input: {
    source: { kind: 'skill' | 'url'; value: string }
    sessionId: string
    signal?: AbortSignal
    executionEnvironment?: ExecutionEnvironment
  }): Promise<ManagedEnvironmentInstallPreview>
  confirmInstall(input: {
    planId: string
    digest: string
    candidateId?: string
    sessionId: string
    permissionConfirmed: boolean
    executionEnvironment: ExecutionEnvironment
    signal?: AbortSignal
  }): Promise<ManagedEnvironmentInstallResult>
  cancel(input: {
    jobId: string
    sessionId: string
  }): Promise<{ cancelled: boolean }>
}

export class ManageEnvironmentTool extends Tool {
  override readonly name = 'manage_environment'
  override readonly description =
    '使用 Emperor 原生 Environment 管理器查询、预览、确认或取消依赖安装。支持的安装配方仅为 python_venv、npm_prefix 和 verified_archive；目标固定为当前 Emperor Managed Environment，模型不能提供命令、argv、shell、目标路径或权限确认。'
  override readonly parameters: ToolParamsSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'status、preview_install、confirm_install 或 cancel',
      },
      source: {
        type: 'object',
        description:
          'preview_install 来源；kind 为已安装 user Skill（skill）或用户给出的 URL（url）',
        properties: {
          kind: { type: 'string', description: 'skill 或 url' },
          value: { type: 'string', description: 'Skill 名称或 HTTPS URL' },
        },
        required: ['kind', 'value'],
        additionalProperties: false,
      },
      planId: { type: 'string', description: 'confirm_install 使用的 plan ID' },
      digest: {
        type: 'string',
        description: 'confirm_install 使用的预览 digest',
      },
      candidateId: {
        type: 'string',
        description: '多候选归档 confirm_install 时选择的候选 ID',
      },
      jobId: { type: 'string', description: 'cancel 使用的 job ID' },
    },
    required: ['action'],
    additionalProperties: false,
  }
  override readonly domainStateMutation = true
  override readonly externalContent = true
  override readonly requiresRuntimeContext = true
  override capabilityProvenance: ToolCapabilityProvenance = {
    kind: 'external_transport',
    transport: 'managed_environment_installer',
    source: 'core_native_environment_installer',
  }
  override evidencePolicy = 'context_only' as const

  private readonly issuerId = randomBytes(16).toString('hex')
  private readonly rootDigest: string

  constructor(
    emperorHome: string,
    private readonly host: NativeEnvironmentInstallHost,
  ) {
    super()
    this.rootDigest = sha256(`manage_environment\0${emperorHome}`)
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    const action = String(args.action ?? '')
    return action === 'status' || action === 'preview_install'
  }

  override getPath(): null {
    return null
  }

  override issueManagedPathCapability(
    args: Record<string, unknown>,
  ): ManageEnvironmentPathCapability {
    const input = normalizeInput(args)
    const relativeTarget =
      input.action === 'status'
        ? 'registry.v1.json'
        : input.action === 'preview_install'
          ? `jobs/managed/preview-${sha256(JSON.stringify(input)).slice(0, 16)}`
          : input.action === 'confirm_install'
            ? `tools/${input.planId}`
            : `jobs/managed/${input.jobId}`
    return Object.freeze({
      version: 1,
      toolName: 'manage_environment',
      issuer: 'core_tool_host',
      issuerId: this.issuerId,
      rootDigest: this.rootDigest,
      action: input.action,
      relativeTarget,
      operationFingerprint: sha256(JSON.stringify(input)),
    })
  }

  override async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.authorized(args, ctx?.managedPathCapability))
      return errResult(
        'authorization_missing: manage_environment requires trusted Runner authorization',
        { meta: { action: String(args.action ?? '') } },
      )
    try {
      const input = normalizeInput(args)
      const sessionId = String(ctx?.sessionId ?? '').trim()
      if (!sessionId) throw new Error('a trusted session context is required')
      if (input.action === 'status') {
        const status = await this.host.status()
        return okResult(JSON.stringify(status, null, 2), {
          summary: '已读取 Emperor Managed Environment 状态',
          meta: { action: 'status' },
        })
      }
      if (input.action === 'preview_install') {
        if (!input.source) throw new Error('preview_install source is required')
        const preview = await this.host.previewInstall({
          source: input.source,
          sessionId,
          signal: ctx?.signal ?? undefined,
          executionEnvironment: ctx?.executionEnvironment ?? undefined,
        })
        return okResult(JSON.stringify(preview, null, 2), {
          summary: `发现 ${preview.candidates.length} 个受限安装配方`,
          meta: {
            action: 'preview_install',
            plan_id: preview.planId,
            candidate_count: preview.candidates.length,
            placement: preview.placement,
          },
        })
      }
      if (input.action === 'confirm_install') {
        if (!ctx?.executionEnvironment)
          throw new Error('trusted ExecutionEnvironment is required')
        const result = await this.host.confirmInstall({
          planId: input.planId,
          digest: input.digest,
          ...(input.candidateId ? { candidateId: input.candidateId } : {}),
          sessionId,
          permissionConfirmed: true,
          executionEnvironment: ctx.executionEnvironment,
          signal: ctx.signal ?? undefined,
        })
        return okResult(JSON.stringify(result, null, 2), {
          summary: `已安装依赖：${result.toolId} ${result.version}`,
          meta: {
            action: 'confirm_install',
            tool: result.toolId,
            version: result.version,
            placement: result.placement,
            status: result.status,
          },
        })
      }
      const result = await this.host.cancel({
        jobId: input.jobId,
        sessionId,
      })
      return okResult(JSON.stringify(result, null, 2), {
        summary: result.cancelled ? '已请求取消安装' : '安装任务当前不可取消',
        meta: { action: 'cancel', cancelled: result.cancelled },
      })
    } catch (error) {
      return errResult(
        `manage_environment failed: ${error instanceof Error ? error.message : String(error)}`,
        { meta: { action: String(args.action ?? '') } },
      )
    }
  }

  private authorized(
    args: Record<string, unknown>,
    capability: ManagedPathCapability | undefined,
  ): boolean {
    if (!capability || capability.toolName !== 'manage_environment')
      return false
    let expected: ManageEnvironmentPathCapability
    try {
      expected = this.issueManagedPathCapability(args)
    } catch {
      return false
    }
    return (
      capability.version === expected.version &&
      capability.issuerId === expected.issuerId &&
      capability.rootDigest === expected.rootDigest &&
      capability.action === expected.action &&
      capability.relativeTarget === expected.relativeTarget &&
      capability.operationFingerprint === expected.operationFingerprint
    )
  }
}

function normalizeInput(args: Record<string, unknown>): {
  action: ManageEnvironmentPathCapability['action']
  source: { kind: 'skill' | 'url'; value: string } | null
  planId: string
  digest: string
  candidateId: string
  jobId: string
} {
  const action = environmentAction(args.action)
  const rawSource =
    args.source &&
    typeof args.source === 'object' &&
    !Array.isArray(args.source)
      ? (args.source as Record<string, unknown>)
      : null
  let source: { kind: 'skill' | 'url'; value: string } | null = null
  if (rawSource) {
    const kind = String(rawSource.kind ?? '').trim()
    const value = String(rawSource.value ?? '').trim()
    if (kind !== 'skill' && kind !== 'url')
      throw new Error('source kind must be skill or url')
    if (!value) throw new Error('source value is required')
    source = { kind, value }
  }
  return {
    action,
    source,
    planId: String(args.planId ?? '').trim(),
    digest: String(args.digest ?? '').trim(),
    candidateId: String(args.candidateId ?? '').trim(),
    jobId: String(args.jobId ?? '').trim(),
  }
}

function environmentAction(
  value: unknown,
): ManageEnvironmentPathCapability['action'] {
  const action = String(value ?? '').trim()
  if (
    action === 'status' ||
    action === 'preview_install' ||
    action === 'confirm_install' ||
    action === 'cancel'
  )
    return action
  throw new Error(
    'manage_environment action must be status, preview_install, confirm_install, or cancel',
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
