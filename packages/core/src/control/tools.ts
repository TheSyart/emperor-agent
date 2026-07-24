/**
 * 控制工具 ask_user / propose_plan (MIG-CTRL-004)。对齐 Python `agent/control/tools.py`。
 * 生成 waiting tool result（__CONTROL_PAUSE__ 前缀）；propose_plan 经质量门。
 */
import { Tool, type ToolExecutionContext } from '../tools/base'
import {
  B,
  S,
  toolParamsSchema,
  type ObjectSchema,
  type ParamSchema,
} from '../tools/schema'
import { PlanQualityError } from '../plans/quality'
import type { PlanRecord } from '../plans/models'
import { interactionToDict, type Interaction } from './models'

export const CONTROL_PAUSE_PREFIX = '__CONTROL_PAUSE__:'

export function controlSessionMeta(
  sessionId?: string | null,
): Record<string, unknown> {
  const normalized = String(sessionId ?? '').trim()
  return normalized ? { control_session_id: normalized } : {}
}

export function makePauseResult(interaction: Record<string, unknown>): string {
  return CONTROL_PAUSE_PREFIX + JSON.stringify({ interaction })
}

export function parsePauseResult(
  value: string,
): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.startsWith(CONTROL_PAUSE_PREFIX))
    return null
  let raw: unknown
  try {
    raw = JSON.parse(value.slice(CONTROL_PAUSE_PREFIX.length))
  } catch {
    return null
  }
  const interaction =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).interaction
      : null
  return interaction && typeof interaction === 'object'
    ? (interaction as Record<string, unknown>)
    : null
}

/** Control 工具调用的 ControlManager 表面。 */
export interface ToolManagerHost {
  createAsk(opts: {
    questions: Array<Record<string, unknown>>
    context?: string
    parentCallId?: string | null
    meta?: Record<string, unknown> | null
  }): Interaction
  createPlan(opts: {
    title: string
    summary: string
    planMarkdown: string
    assumptions?: string[] | null
    riskLevel?: string
    steps?: Array<Record<string, unknown>> | null
    parentCallId?: string | null
    meta?: Record<string, unknown> | null
    enforceQuality?: boolean
  }): Interaction
  completePlanStep?(input: {
    stepId: string
    summary: string
    toolCallId?: string | null
    turnId?: string | null
  }): PlanRecord
}

type ToolManagerHostProvider =
  ToolManagerHost | ((sessionId?: string | null) => ToolManagerHost)

function resolveToolManager(
  provider: ToolManagerHostProvider,
  ctx?: ToolExecutionContext,
): ToolManagerHost {
  return typeof provider === 'function' ? provider(ctx?.sessionId) : provider
}

function obj(
  description: string,
  properties: Record<string, ParamSchema>,
  required?: string[],
): ObjectSchema {
  return { type: 'object', description, properties, required: required ?? [] }
}

function arr(description: string, items: ParamSchema): ParamSchema {
  return { type: 'array', description, items }
}

export class AskUserTool extends Tool {
  override name = 'ask_user'
  override exclusive = true
  override requiresRuntimeContext = true
  override evidencePolicy = 'forbidden' as const
  override description =
    '向用户提出结构化澄清问题并暂停当前回合。' +
    '仅用于目标、范围、产品取舍、验收或成本边界会改变实现路径的关键不确定点；' +
    '不得用它请求工具执行权限，也不得在用户已经明确目标和对象后重复要求文字确认；' +
    '能通过读文件、搜索或只读探索确认的事实，不应询问用户。' +
    '每次提出 1-3 个问题，每题 2-4 个互斥选项，推荐选项放在首位。'

  override parameters = toolParamsSchema(
    {
      questions: arr(
        '1-3 个澄清问题',
        obj(
          '一个澄清问题',
          {
            id: S('稳定 snake_case/短 id，用于答案映射'),
            header: S('短标题，最多 12 个汉字或等长文本'),
            question: S('要问用户的问题，单句表达'),
            options: arr(
              '2-4 个互斥选项',
              obj(
                '可选答案',
                {
                  label: S('用户可选的短标签，建议 1-5 个词'),
                  description: S('选择该项的影响或取舍，单句说明'),
                },
                ['label'],
              ),
            ),
          },
          ['id', 'header', 'question', 'options'],
        ),
      ),
      context: S('为什么需要提问的简短上下文，可为空'),
    },
    ['questions'],
  )

  private readonly managerProvider: ToolManagerHostProvider
  constructor(manager: ToolManagerHostProvider) {
    super()
    this.managerProvider = manager
  }

  execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): string {
    const interaction = resolveToolManager(this.managerProvider, ctx).createAsk(
      {
        questions: (args.questions as Array<Record<string, unknown>>) ?? [],
        context: String(args.context ?? ''),
        parentCallId: ctx?.parentCallId ?? null,
        meta: controlSessionMeta(ctx?.sessionId),
      },
    )
    return makePauseResult(interactionToDict(interaction))
  }
}

export const PLAN_MODE_REQUEST_QUESTION_ID = 'enter_plan_mode'
export const PLAN_MODE_REQUEST_APPROVE_LABEL = '同意进入计划模式'
export const PLAN_MODE_REQUEST_DECLINE_LABEL = '暂不进入'

export class RequestPlanModeTool extends Tool {
  override name = 'request_plan_mode'
  override exclusive = true
  override requiresRuntimeContext = true
  override evidencePolicy = 'forbidden' as const
  override description =
    '当任务属于高影响改动（多文件重构、后端/权限/调度变更等）且当前不在计划模式时，' +
    '用此工具请求用户切换到计划模式并暂停当前回合；用户一键同意后即可开始只读探索并用 propose_plan 提交计划。' +
    '不要用 ask_user 现场组织措辞来请求切换模式。'

  override parameters = toolParamsSchema(
    { reason: S('为什么这个任务需要先进入计划模式，单句说明') },
    ['reason'],
  )

  private readonly managerProvider: ToolManagerHostProvider
  constructor(manager: ToolManagerHostProvider) {
    super()
    this.managerProvider = manager
  }

  execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): string {
    const reason = String(args.reason ?? '').trim() || '高影响改动需要先规划'
    const interaction = resolveToolManager(this.managerProvider, ctx).createAsk(
      {
        questions: [
          {
            id: PLAN_MODE_REQUEST_QUESTION_ID,
            header: '计划模式',
            question: `模型请求切换到计划模式：${reason}`,
            options: [
              {
                label: PLAN_MODE_REQUEST_APPROVE_LABEL,
                description: '切换后模型先只读探索并提交计划，批准后才动手改动',
              },
              {
                label: PLAN_MODE_REQUEST_DECLINE_LABEL,
                description: '保持当前模式，模型将改用澄清提问或缩小改动范围',
              },
            ],
          },
        ],
        context: reason,
        parentCallId: ctx?.parentCallId ?? null,
        meta: {
          plan_mode_request: true,
          ...controlSessionMeta(ctx?.sessionId),
        },
      },
    )
    return makePauseResult(interactionToDict(interaction))
  }
}

export class ProposePlanTool extends Tool {
  override name = 'propose_plan'
  override exclusive = true
  override requiresRuntimeContext = true
  override evidencePolicy = 'forbidden' as const
  override description =
    '提交等待用户预览、评论或批准的计划，并暂停当前回合。' +
    '只在计划模式中使用；计划必须完整、可执行、决策明确，并写清验证方式、风险和假设。' +
    '不要用普通最终回复替代计划卡；仍有关键问题时先 ask_user。'

  override parameters = toolParamsSchema(
    {
      title: S('计划标题'),
      summary: S('计划摘要'),
      plan_markdown: S('完整 Markdown 计划正文'),
      assumptions: arr('明确采用的假设，可为空数组', S('单条假设')),
      risk_level: S('风险级别 low/medium/high'),
      steps: arr(
        '结构化执行步骤。每一步必须可验证；复杂项目至少 2 步。',
        obj(
          '计划步骤',
          {
            id: S('稳定步骤 id，如 step_1'),
            title: S('步骤标题'),
            description: S('步骤说明'),
            files: arr('涉及文件', S('文件路径')),
            commands: arr('验证或执行命令', S('命令')),
            acceptance: arr('验收条件', S('验收条件')),
            discovery_refs: arr('引用的 PlanDiscovery id', S('discovery id')),
            depends_on: arr(
              '前置步骤 id；所有依赖完成后才能激活本步骤',
              S('step id'),
            ),
            verification: arr(
              '验证矩阵；required/optional/manual/reviewer/smoke',
              obj(
                '验证要求',
                {
                  id: S('稳定 requirement id'),
                  kind: S('验证类型 command/manual/reviewer/smoke'),
                  required: B('是否为阻塞性必需验证'),
                  human_required: B(
                    '仅当用户明确要求必须由人工验收时设为 true；普通浏览器目视建议保持 false',
                  ),
                  command: S('命令型验证的命令'),
                  description: S('验证说明'),
                },
                ['id', 'kind'],
              ),
            ),
            risk: S('风险级别 low/medium/high'),
            risk_note: S('高风险步骤的风险说明'),
            rollback: S('高风险步骤的回滚路径或降级方案'),
          },
          ['id', 'title'],
        ),
      ),
    },
    ['title', 'summary', 'plan_markdown', 'steps'],
  )

  private readonly managerProvider: ToolManagerHostProvider
  constructor(manager: ToolManagerHostProvider) {
    super()
    this.managerProvider = manager
  }

  execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): string {
    let interaction: Interaction
    try {
      interaction = resolveToolManager(this.managerProvider, ctx).createPlan({
        title: String(args.title ?? ''),
        summary: String(args.summary ?? ''),
        planMarkdown: String(args.plan_markdown ?? ''),
        assumptions: (args.assumptions as string[]) ?? [],
        riskLevel: String(args.risk_level ?? 'medium'),
        steps: (args.steps as Array<Record<string, unknown>>) ?? [],
        parentCallId: ctx?.parentCallId ?? null,
        meta: controlSessionMeta(ctx?.sessionId),
        enforceQuality: true,
      })
    } catch (exc) {
      if (exc instanceof PlanQualityError) return exc.message
      throw exc
    }
    return makePauseResult(interactionToDict(interaction))
  }
}

export class CompletePlanStepTool extends Tool {
  override name = 'complete_plan_step'
  override exclusive = true
  override requiresRuntimeContext = true
  override evidencePolicy = 'forbidden' as const
  override readOnly = true
  override description =
    '报告当前活动 PlanStep 的实现工作已经完成，由 Core 记录实现声明并进入验证或下一步骤。' +
    '只在已批准计划的执行阶段使用；它不会伪造验证成功，也不会绕过必需验证。' +
    '不要为了镜像单个 PlanStep 创建 Todo；只有确有多个独立执行事项时才使用 update_todos。'

  override parameters = toolParamsSchema(
    {
      step_id: S('当前活动 PlanStep 的稳定 id'),
      summary: S('本步骤实际完成的实现内容和关键变更摘要'),
    },
    ['step_id', 'summary'],
  )

  private readonly managerProvider: ToolManagerHostProvider
  constructor(manager: ToolManagerHostProvider) {
    super()
    this.managerProvider = manager
  }

  execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): string {
    const stepId = String(args.step_id ?? '').trim()
    const summary = String(args.summary ?? '').trim()
    const manager = resolveToolManager(this.managerProvider, ctx)
    if (typeof manager.completePlanStep !== 'function')
      throw new Error('complete_plan_step is unavailable')
    const record = manager.completePlanStep({
      stepId,
      summary,
      toolCallId: ctx?.parentCallId ?? null,
      turnId: ctx?.turnId ?? null,
    })
    const step = record.steps.find((item) => item.id === stepId)
    return [
      `Plan step completed: ${stepId}`,
      `step_status=${step?.status ?? 'unknown'}`,
      `plan_status=${record.status}`,
    ].join('\n')
  }
}
