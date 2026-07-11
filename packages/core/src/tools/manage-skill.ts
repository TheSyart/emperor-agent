import type { SkillManager, SkillResourceDirectory } from '../skills/manager'
import { Tool } from './base'
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

  private readonly manager: SkillManager
  private readonly onSkillsChanged: (() => void) | null

  constructor(manager: SkillManager, onSkillsChanged?: () => void) {
    super()
    this.manager = manager
    this.onSkillsChanged = onSkillsChanged ?? null
  }

  override isReadOnly(args: Record<string, unknown>): boolean {
    return String(args.action ?? '') === 'validate'
  }

  override getPath(args: Record<string, unknown>): string {
    const name = String(args.name ?? '').trim()
    return String(args.action ?? '') === 'package'
      ? this.manager.packageOutputDir()
      : this.manager.userSkillPath(name)
  }

  execute(args: Record<string, unknown>): string {
    const action = String(args.action ?? '').trim()
    const name = String(args.name ?? '').trim()
    if (!ACTIONS.has(action))
      return 'Error: manage_skill action must be create, validate, or package'

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
}
