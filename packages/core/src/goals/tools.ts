import { EmperorError } from '../errors'
import { Tool, type ToolExecutionContext } from '../tools/base'
import {
  B,
  S,
  type ObjectSchema,
  type ParamSchema,
  type ToolParamsSchema,
} from '../tools/schema'
import type {
  GoalBlockInput,
  GoalCompletionGate,
  GoalCompletionResult,
} from './completion-gate'
import type {
  GoalEvidence,
  GoalEvidenceLedger,
  RecordGoalEvidenceInput,
} from './evidence'
import {
  isGoalTerminal,
  type GoalAcceptanceCriterion,
  type GoalRecord,
} from './models'
import type { GoalStore } from './store'
import { GoalContractValidator } from './validation'

export const GOAL_TOOL_NAMES = Object.freeze([
  'get_goal',
  'define_goal_contract',
  'record_goal_evidence',
  'complete_goal',
  'block_goal',
] as const)

const GOAL_WRITE_TOOL_NAMES = new Set<string>(GOAL_TOOL_NAMES.slice(1))

export interface DefineGoalContractInput {
  readonly inScope: string[]
  readonly outOfScope: string[]
  readonly constraints: string[]
  readonly acceptanceCriteria: GoalAcceptanceCriterion[]
  readonly escalationConditions: string[]
}

export interface BlockGoalInput {
  readonly reason: string
  readonly requiredPermission: string | null
}

export interface GoalBlockerPending {
  readonly pending: true
  readonly goalId: string
  readonly interactionId: string
}

export class GoalToolError extends EmperorError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

interface GoalToolHostOptions {
  readonly goalStore: Pick<GoalStore, 'listReadonly' | 'append'>
  readonly evidenceLedger: Pick<GoalEvidenceLedger, 'record' | 'listEvidence'>
  readonly completionGate: Pick<GoalCompletionGate, 'complete'>
  readonly blockGoal: (
    goal: GoalRecord,
    input: GoalBlockInput,
  ) => Promise<GoalRecord>
  readonly requestPermissionBlockerResolution?: (
    goal: GoalRecord,
    reason: string,
  ) => { readonly id: string }
  readonly hasAnswerableInteraction?: (goal: GoalRecord) => boolean
  readonly enterPlanMode?: (goal: GoalRecord) => void
  readonly now?: () => string
}

/**
 * The host is the authority boundary for model-facing Goal tools. Tools submit
 * intent only; Goal identity and all terminal state come from the session and
 * Core-owned stores.
 */
export class GoalToolHost {
  private readonly now: () => string

  constructor(private readonly options: GoalToolHostOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async visibleToolNames(
    sessionIdValue: string | null | undefined,
  ): Promise<readonly string[]> {
    const goal = await this.currentGoal(sessionIdValue)
    if (!goal) return []
    return isGoalTerminal(goal.status) ? ['get_goal'] : GOAL_TOOL_NAMES
  }

  async currentGoal(
    sessionIdValue: string | null | undefined,
  ): Promise<GoalRecord | null> {
    const sessionId = String(sessionIdValue ?? '').trim()
    if (!sessionId) return null
    const scoped = (await this.options.goalStore.listReadonly()).filter(
      (goal) => goal.scope.sessionId === sessionId,
    )
    return (
      scoped.find((goal) => !isGoalTerminal(goal.status)) ?? scoped[0] ?? null
    )
  }

  async requireCurrent(
    context: ToolExecutionContext | undefined,
    options: { writable?: boolean } = {},
  ): Promise<GoalRecord> {
    const goal = await this.currentGoal(context?.sessionId)
    if (!goal)
      throw new GoalToolError(
        'goal_tool_no_current_goal',
        'This session has no current Goal.',
      )
    if (options.writable && isGoalTerminal(goal.status))
      throw new GoalToolError(
        'goal_tool_terminal_read_only',
        'A terminal Goal is read-only.',
      )
    return goal
  }

  async snapshot(
    context: ToolExecutionContext | undefined,
  ): Promise<Record<string, unknown>> {
    const goal = await this.requireCurrent(context)
    const allEvidence = await this.options.evidenceLedger.listEvidence(goal.id)
    const evidence = new Map(allEvidence.map((item) => [item.id, item]))
    const counts = { passed: 0, failed: 0, missing: 0, total: 0 }
    for (const criterion of goal.contract.acceptanceCriteria) {
      counts.total += 1
      const latest = evidence.get(
        goal.latestEvidenceByCriterion[criterion.id] ?? '',
      )
      if (latest?.verdict === 'pass') counts.passed += 1
      else if (latest?.verdict === 'fail') counts.failed += 1
      else counts.missing += 1
    }
    return {
      goalId: goal.id,
      status: goal.status,
      phase: goal.runtime.phase,
      outcome: goal.contract.outcome,
      currentPlanId: goal.runtime.currentPlanId,
      cyclesUsed: goal.runtime.cyclesUsed,
      acceptance: counts,
      pauseReason: goal.runtime.pauseReason,
      lastEventSeq: goal.lastEventSeq,
      updatedAt: goal.updatedAt,
    }
  }

  async defineContract(
    context: ToolExecutionContext | undefined,
    input: DefineGoalContractInput,
  ): Promise<GoalRecord> {
    const goal = await this.requireCurrent(context, { writable: true })
    const next = GoalContractValidator.lock(goal, input, this.now())
    const locked = await this.options.goalStore.append(goal.id, {
      type: 'goal_updated',
      record: next,
      createdAt: next.updatedAt,
      expectedLastEventSeq: goal.lastEventSeq,
      data: { reason: 'goal_contract_defined' },
    })
    this.options.enterPlanMode?.(locked)
    return locked
  }

  async recordEvidence(
    context: ToolExecutionContext | undefined,
    input: RecordGoalEvidenceInput,
  ): Promise<GoalEvidence> {
    const goal = await this.requireCurrent(context, { writable: true })
    return await this.options.evidenceLedger.record(goal.id, input, {
      recorder: 'agent',
    })
  }

  async complete(
    context: ToolExecutionContext | undefined,
  ): Promise<GoalCompletionResult> {
    const goal = await this.requireCurrent(context, { writable: true })
    return await this.options.completionGate.complete(goal.id)
  }

  async block(
    context: ToolExecutionContext | undefined,
    input: BlockGoalInput,
  ): Promise<GoalBlockerPending> {
    const goal = await this.requireCurrent(context, { writable: true })
    const reason = requiredText(input.reason, 'reason')
    if (looksLikeRecoverableVerificationFailure(reason))
      throw new GoalToolError(
        'goal_block_recoverable_failure',
        'A test or verification failure is recoverable and cannot terminally block a Goal.',
      )
    if (!String(input.requiredPermission ?? '').trim())
      throw new GoalToolError(
        'goal_block_permission_required',
        'Goal v1 terminal blocking requires a concrete permission denial.',
      )
    if (this.options.hasAnswerableInteraction?.(goal))
      throw new GoalToolError(
        'goal_block_interaction_answerable',
        'Resolve the current Ask interaction before blocking the Goal.',
      )
    const interaction = this.options.requestPermissionBlockerResolution?.(
      goal,
      reason,
    )
    if (!interaction)
      throw new GoalToolError(
        'goal_block_control_unavailable',
        'Goal permission blocker confirmation is unavailable.',
      )
    return { pending: true, goalId: goal.id, interactionId: interaction.id }
  }
}

abstract class GoalTool extends Tool {
  override requiresRuntimeContext = true
  override exclusive = true
  override evidencePolicy = 'forbidden' as const

  constructor(protected readonly host: GoalToolHost) {
    super()
  }
}

export class GetGoalTool extends GoalTool {
  override readonly name = 'get_goal'
  override readonly description =
    '读取当前 session 的 Core 持久化 Goal 摘要。Goal 由运行时选择，不接受 goalId。'
  override readonly parameters = strictSchema({})
  override readOnly = true

  async execute(
    _args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    return boundedJson(await this.host.snapshot(context), 4_000)
  }
}

export class DefineGoalContractTool extends GoalTool {
  override readonly name = 'define_goal_contract'
  override readonly domainStateMutation = true
  override readonly description =
    '锁定当前 Goal 的范围、约束与验收条件并进入 planning。Outcome 由 Core 保持不变；仍有关键不确定项时先 ask_user。'
  override readonly parameters = strictSchema(
    {
      in_scope: arrayOf('Goal 范围内事项', S('单项范围')),
      out_of_scope: arrayOf('Goal 范围外事项', S('单项排除')),
      constraints: arrayOf('必须遵守的约束', S('单项约束')),
      acceptance_criteria: arrayOf(
        '按 AC-1、AC-2 顺序定义的验收条件',
        strictObject(
          '一个验收条件',
          {
            id: S('稳定顺序 ID，例如 AC-1'),
            description: S('可观察、可验证的验收描述'),
            required: B('是否为阻塞完成的必要条件'),
            verification: strictObject(
              '验证方法',
              {
                kind: S('command/artifact/manual/reviewer'),
                requirement: S('具体验证要求'),
              },
              ['kind', 'requirement'],
            ),
          },
          ['id', 'description', 'required', 'verification'],
        ),
      ),
      escalation_conditions: arrayOf(
        '需要暂停并向用户升级的条件',
        S('单项升级条件'),
      ),
    },
    [
      'in_scope',
      'out_of_scope',
      'constraints',
      'acceptance_criteria',
      'escalation_conditions',
    ],
  )

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const goal = await this.host.defineContract(context, {
      inScope: stringArray(args.in_scope),
      outOfScope: stringArray(args.out_of_scope),
      constraints: stringArray(args.constraints),
      acceptanceCriteria:
        (args.acceptance_criteria as GoalAcceptanceCriterion[]) ?? [],
      escalationConditions: stringArray(args.escalation_conditions),
    })
    return boundedJson({
      goalId: goal.id,
      status: goal.status,
      phase: goal.runtime.phase,
      outcome: goal.contract.outcome,
      contractRevision: goal.contract.revision,
    })
  }
}

export class RecordGoalEvidenceTool extends GoalTool {
  override readonly name = 'record_goal_evidence'
  override readonly domainStateMutation = true
  override readonly description =
    '把已由 Core 捕获的 observation/receipt source IDs 关联到当前 Goal 验收项；不能提交路径、hash、工具名或原始输出。'
  override readonly parameters = strictSchema(
    {
      criterion_id: S('当前 Goal 中的验收项 ID'),
      verdict: S('pass 或 fail'),
      check: S('执行的验证检查'),
      summary: S('简短结果摘要，不含原始输出'),
      source_observation_ids: arrayOf(
        'Core observation IDs',
        S('observation ID'),
      ),
      source_receipt_ids: arrayOf('Core receipt IDs', S('receipt ID')),
    },
    [
      'criterion_id',
      'verdict',
      'check',
      'summary',
      'source_observation_ids',
      'source_receipt_ids',
    ],
  )

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const verdict = String(args.verdict ?? '')
    if (verdict !== 'pass' && verdict !== 'fail')
      throw new GoalToolError(
        'goal_evidence_verdict_invalid',
        'Evidence verdict must be pass or fail.',
      )
    const evidence = await this.host.recordEvidence(context, {
      criterionId: requiredText(args.criterion_id, 'criterion_id'),
      verdict,
      check: requiredText(args.check, 'check'),
      summary: requiredText(args.summary, 'summary'),
      sourceObservationIds: stringArray(args.source_observation_ids),
      sourceReceiptIds: stringArray(args.source_receipt_ids),
    })
    return boundedJson({
      evidenceId: evidence.id,
      criterionId: evidence.criterionId,
    })
  }
}

export class CompleteGoalTool extends GoalTool {
  override readonly name = 'complete_goal'
  override readonly domainStateMutation = true
  override readonly description =
    '请求 Core 对当前 Goal 执行完成门禁与终态提交。不能直接指定完成状态；失败时返回稳定 Gate reason codes。'
  override readonly parameters = strictSchema({})

  async execute(
    _args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const result = await this.host.complete(context)
      return boundedJson({
        completed: true,
        goalId: result.goal.id,
        receiptId: result.receipt.id,
        evidenceIds: result.receipt.evidenceIds,
        postCommitFailureCodes: result.postCommitFailures.map(
          (failure) => failure.code,
        ),
      })
    } catch (error) {
      const gate = isRecord(error) && isRecord(error.gate) ? error.gate : null
      if (gate && Array.isArray(gate.reasons)) {
        return boundedJson({
          completed: false,
          reasonCodes: gate.reasons
            .filter(isRecord)
            .map((reason) => String(reason.code ?? ''))
            .filter(Boolean),
        })
      }
      throw error
    }
  }
}

export class BlockGoalTool extends GoalTool {
  override readonly name = 'block_goal'
  override readonly domainStateMutation = true
  override readonly description =
    '仅在缺失权限可能使当前 Goal 无法继续时请求专用用户确认。确认拒绝后由 Core 写入 terminal block；测试失败继续修复。'
  override readonly parameters = strictSchema(
    {
      reason: S('不含敏感原始输出的阻塞原因'),
      required_permission: nullableString(
        '当前缺失且必须由用户确认是否可获得的权限',
      ),
    },
    ['reason', 'required_permission'],
  )

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const pending = await this.host.block(context, {
      reason: String(args.reason ?? ''),
      requiredPermission: nullableText(args.required_permission),
    })
    return boundedJson({
      blocked: false,
      awaitingUser: true,
      goalId: pending.goalId,
      interactionId: pending.interactionId,
    })
  }
}

export function filterGoalToolDefinitions<T extends { readonly name: string }>(
  definitions: readonly T[],
  visibleNames: readonly string[],
): T[] {
  const visible = new Set(visibleNames)
  return definitions.filter(
    (definition) =>
      !GOAL_TOOL_NAMES.includes(
        definition.name as (typeof GOAL_TOOL_NAMES)[number],
      ) || visible.has(definition.name),
  )
}

export function isGoalWriteTool(name: string): boolean {
  return GOAL_WRITE_TOOL_NAMES.has(name)
}

function strictSchema(
  properties: Record<string, ParamSchema>,
  required: string[] = [],
): ToolParamsSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

function strictObject(
  description: string,
  properties: Record<string, ParamSchema>,
  required: string[] = [],
): ObjectSchema {
  return {
    type: 'object',
    description,
    properties,
    required,
    additionalProperties: false,
  }
}

function arrayOf(description: string, items: ParamSchema): ParamSchema {
  return { type: 'array', description, items }
}

function nullableString(description: string): ParamSchema {
  return { type: ['string', 'null'], description }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item).trim()).filter(Boolean)
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value).trim() || null
}

function requiredText(value: unknown, field: string): string {
  const text = String(value ?? '').trim()
  if (!text)
    throw new GoalToolError('goal_tool_input_invalid', `${field} is required.`)
  return text
}

function boundedJson(value: unknown, maxChars = 8_000): string {
  const text = JSON.stringify(value)
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function looksLikeRecoverableVerificationFailure(reason: string): boolean {
  return /\b(test|tests|build|lint|typecheck|verification|check)\b.*\b(fail|failed|error|broken)\b/i.test(
    reason,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
