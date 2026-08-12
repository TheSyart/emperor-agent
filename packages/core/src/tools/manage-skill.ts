import { createHash, randomBytes } from 'node:crypto'
import type { SkillManager, SkillResourceDirectory } from '../skills/manager'
import {
  Tool,
  type ManageSkillPathCapability,
  type ManagedPathCapability,
  type ToolExecutionContext,
} from './base'
import type { ToolParamsSchema } from './schema'

const ACTIONS = new Set(['create', 'validate', 'package'])
const RESOURCES = new Set<SkillResourceDirectory>([
  'scripts',
  'references',
  'assets',
])

export class ManageSkillTool extends Tool {
  override readonly name = 'manage_skill'
  override readonly description =
    '使用 Emperor Core 原生能力创建、校验或打包用户 Skill。action=create 需要 name 和 description；validate/package 需要 name。输出为结构化 JSON。'
  override readonly parameters: ToolParamsSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'create、validate 或 package' },
      name: {
        type: 'string',
        description: '小写字母、数字和连字符组成的 Skill 名称',
      },
      description: {
        type: 'string',
        description: '创建 Skill 时使用的完整触发描述',
      },
      resources: {
        type: 'array',
        items: { type: 'string', description: '资源目录名' },
        description: '可选资源目录：scripts、references、assets',
      },
      content: {
        type: 'string',
        description: '可选的待校验 SKILL.md 内容；不写入磁盘',
      },
    },
    required: ['action', 'name'],
  }
  override readonly domainStateMutation = true
  override evidencePolicy = 'forbidden' as const

  private readonly manager: SkillManager
  private readonly onSkillsChanged: (() => void) | null
  private readonly issuerId = randomBytes(16).toString('hex')
  private readonly rootDigest: string

  constructor(manager: SkillManager, onSkillsChanged?: () => void) {
    super()
    this.manager = manager
    this.onSkillsChanged = onSkillsChanged ?? null
    this.rootDigest = sha256(`manage_skill\0${manager.userSkillsDir}`)
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    return String(args.action ?? '') === 'validate'
  }

  override getPath(_args: Record<string, unknown>): null {
    // The user Skill root is outside the workspace. Runner-issued capability
    // validation below is its sole path authority.
    return null
  }

  override issueManagedPathCapability(
    args: Record<string, unknown>,
  ): ManageSkillPathCapability {
    const action = managedAction(args.action)
    const name = String(args.name ?? '').trim()
    const relativeTarget =
      action === 'package' ? `skill-packages/${name}.skill` : `skills/${name}`
    return Object.freeze({
      version: 1,
      toolName: 'manage_skill',
      issuer: 'core_tool_host',
      issuerId: this.issuerId,
      rootDigest: this.rootDigest,
      action,
      relativeTarget,
      operationFingerprint: operationFingerprint(args),
    })
  }

  execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): string {
    const action = String(args.action ?? '').trim()
    const name = String(args.name ?? '').trim()
    if (!ACTIONS.has(action))
      return 'Error: manage_skill action must be create, validate, or package'
    if (!this.authorized(args, ctx?.managedPathCapability))
      return 'Error: authorization_missing: manage_skill requires a trusted managed path capability'

    try {
      if (action === 'create') {
        const rawResources = Array.isArray(args.resources) ? args.resources : []
        const resources: SkillResourceDirectory[] = []
        for (const item of rawResources) {
          const resource = String(item) as SkillResourceDirectory
          if (!RESOURCES.has(resource))
            throw new Error(`Unsupported Skill resource directory: ${resource}`)
          resources.push(resource)
        }
        const created = this.manager.create({
          name,
          description: String(args.description ?? ''),
          resources,
        })
        this.onSkillsChanged?.()
        return JSON.stringify(created, null, 2)
      }
      if (action === 'validate') {
        return JSON.stringify(
          this.manager.validate({
            name,
            ...(typeof args.content === 'string'
              ? { content: args.content }
              : {}),
          }),
          null,
          2,
        )
      }
      return JSON.stringify(this.manager.package({ name }), null, 2)
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private authorized(
    args: Record<string, unknown>,
    capability: ManagedPathCapability | undefined,
  ): boolean {
    if (!capability) return false
    let expected: ManageSkillPathCapability
    try {
      expected = this.issueManagedPathCapability(args)
    } catch {
      return false
    }
    return (
      capability.version === expected.version &&
      capability.toolName === expected.toolName &&
      capability.issuer === expected.issuer &&
      capability.issuerId === expected.issuerId &&
      capability.rootDigest === expected.rootDigest &&
      capability.action === expected.action &&
      capability.relativeTarget === expected.relativeTarget &&
      capability.operationFingerprint === expected.operationFingerprint
    )
  }
}

function managedAction(value: unknown): ManageSkillPathCapability['action'] {
  const action = String(value ?? '').trim()
  if (action === 'create' || action === 'validate' || action === 'package')
    return action
  throw new Error('invalid manage_skill action')
}

function operationFingerprint(args: Record<string, unknown>): string {
  return sha256(
    JSON.stringify({
      action: String(args.action ?? '').trim(),
      name: String(args.name ?? '').trim(),
      description: String(args.description ?? ''),
      resources: Array.isArray(args.resources)
        ? args.resources.map((item) => String(item))
        : [],
      content: typeof args.content === 'string' ? args.content : null,
    }),
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
