import { createHash, randomBytes } from 'node:crypto'
import { relative, resolve, sep } from 'node:path'
import type {
  SkillInstallPreview,
  SkillInstallResult,
  SkillInstallSourceInput,
} from '../skills/install'
import type { SkillManager } from '../skills/manager'
import {
  Tool,
  errResult,
  okResult,
  type InstallSkillPathCapability,
  type ManagedPathCapability,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolCapabilityProvenance,
} from './base'
import type { ToolParamsSchema } from './schema'

export interface NativeSkillInstallHost {
  previewInstall(input: {
    source: SkillInstallSourceInput
  }): Promise<SkillInstallPreview>
  confirmInstall(input: {
    previewId: string
    digest: string
    candidateId?: string
    permissionConfirmed: boolean
  }): Promise<SkillInstallResult>
}

export class InstallSkillTool extends Tool {
  override readonly name = 'install_skill'
  override readonly description =
    '使用 Emperor 原生安装器预览或确认安装用户 Skill。preview 接受 GitHub/repo/tree/blob/raw URL、.skill/.zip URL 或本地归档；confirm 只能消费之前的 previewId、digest 和可选 candidateId。目标固定为当前 Emperor User Skills。'
  override readonly parameters: ToolParamsSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'preview 或 confirm',
      },
      source: {
        type: 'object',
        description:
          'preview 来源；kind 为 url 或 local，value 为 URL 或本地归档路径',
        properties: {
          kind: { type: 'string', description: 'url 或 local' },
          value: { type: 'string', description: '来源 URL 或本地归档路径' },
        },
        required: ['kind', 'value'],
      },
      previewId: { type: 'string', description: 'confirm 使用的预览 ID' },
      digest: { type: 'string', description: 'confirm 使用的预览 SHA-256' },
      candidateId: {
        type: 'string',
        description: '多候选仓库 confirm 时选择的 candidate ID',
      },
    },
    required: ['action'],
  }
  override readonly domainStateMutation = true
  override readonly externalContent = true
  override capabilityProvenance: ToolCapabilityProvenance = {
    kind: 'external_transport',
    transport: 'skill_asset_downloader',
    source: 'core_native_skill_installer',
  }
  override evidencePolicy = 'context_only' as const

  private readonly issuerId = randomBytes(16).toString('hex')
  private readonly rootDigest: string

  constructor(
    private readonly installer: NativeSkillInstallHost,
    private readonly manager: SkillManager,
    private readonly onSkillsChanged: (() => void) | null = null,
  ) {
    super()
    this.rootDigest = sha256(`install_skill\0${manager.userSkillsDir}`)
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    return String(args.action ?? '') === 'preview'
  }

  override getPath(): null {
    return null
  }

  override issueManagedPathCapability(
    args: Record<string, unknown>,
  ): InstallSkillPathCapability {
    const action = installAction(args.action)
    const relativeTarget =
      action === 'preview'
        ? `.staging/${sha256(JSON.stringify(args)).slice(0, 16)}`
        : String(args.previewId ?? '').trim()
    return Object.freeze({
      version: 1,
      toolName: 'install_skill',
      issuer: 'core_tool_host',
      issuerId: this.issuerId,
      rootDigest: this.rootDigest,
      action,
      relativeTarget,
      operationFingerprint: sha256(JSON.stringify(normalizeInput(args))),
    })
  }

  override async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.authorized(args, ctx?.managedPathCapability))
      return errResult(
        'authorization_missing: install_skill requires trusted Runner authorization',
        { meta: { action: String(args.action ?? '') } },
      )
    try {
      if (String(args.action) === 'preview') {
        const source = sourceInput(args.source)
        const preview = await this.installer.previewInstall({ source })
        return okResult(JSON.stringify(preview, null, 2), {
          summary: `发现 ${preview.candidates.length} 个 Skill 候选`,
          meta: {
            action: 'preview',
            preview_id: preview.previewId,
            candidate_count: preview.candidates.length,
          },
        })
      }
      const input = normalizeInput(args)
      const result = await this.installer.confirmInstall({
        previewId: input.previewId,
        digest: input.digest,
        ...(input.candidateId ? { candidateId: input.candidateId } : {}),
        permissionConfirmed: true,
      })
      const record = this.manager.resolve(result.name)
      if (
        !record ||
        record.source !== 'user' ||
        !inside(this.manager.userSkillsDir, record.root) ||
        (record.status !== 'active' && record.status !== 'blocked')
      )
        throw new Error(
          'installed Skill did not resolve from current User Skills',
        )
      this.onSkillsChanged?.()
      const payload = {
        ...result,
        sourceScope: 'user',
        target: relative(this.manager.stateRoot, record.root).replace(
          /\\/g,
          '/',
        ),
        readOnly: false,
      }
      return okResult(JSON.stringify(payload, null, 2), {
        summary: `已安装 Skill：${result.name}（${result.status}）`,
        meta: {
          action: 'confirm',
          skill: result.name,
          source: 'user',
          status: result.status,
        },
      })
    } catch (error) {
      return errResult(
        `install_skill failed: ${error instanceof Error ? error.message : String(error)}`,
        { meta: { action: String(args.action ?? '') } },
      )
    }
  }

  private authorized(
    args: Record<string, unknown>,
    capability: ManagedPathCapability | undefined,
  ): boolean {
    if (!capability || capability.toolName !== 'install_skill') return false
    let expected: InstallSkillPathCapability
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

function installAction(value: unknown): 'preview' | 'confirm' {
  const action = String(value ?? '').trim()
  if (action === 'preview' || action === 'confirm') return action
  throw new Error('install_skill action must be preview or confirm')
}

function normalizeInput(args: Record<string, unknown>): {
  action: 'preview' | 'confirm'
  source: { kind: string; value: string } | null
  previewId: string
  digest: string
  candidateId: string
} {
  const source =
    args.source &&
    typeof args.source === 'object' &&
    !Array.isArray(args.source)
      ? (args.source as Record<string, unknown>)
      : null
  return {
    action: installAction(args.action),
    source: source
      ? { kind: String(source.kind ?? ''), value: String(source.value ?? '') }
      : null,
    previewId: String(args.previewId ?? '').trim(),
    digest: String(args.digest ?? '').trim(),
    candidateId: String(args.candidateId ?? '').trim(),
  }
}

function sourceInput(value: unknown): SkillInstallSourceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('preview source is required')
  const source = value as Record<string, unknown>
  const kind = String(source.kind ?? '')
  const input = String(source.value ?? '').trim()
  if (!input) throw new Error('preview source value is required')
  if (kind === 'url') return { kind: 'url', url: input }
  if (kind === 'local') return { kind: 'local', path: input }
  throw new Error('preview source kind must be url or local')
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
