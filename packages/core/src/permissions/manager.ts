/**
 * PermissionManager (MIG-CTRL-017)。对齐 Python `agent/permissions/manager.py`。
 * approve/deny-once 指纹 + plan token；高风险 run_command 在 token 前先评估 (PE-13)。
 */
import type { ToolRegistry } from '../tools/registry'
import { controlSessionMeta, makePauseResult } from '../control/tools'
import {
  PermissionDecision,
  stableJson,
  traceEntry,
  type PermissionDecisionExplanation,
  type PermissionTraceEntry,
  type PlanPermissionToken,
} from './models'
import { PermissionPolicy } from './policy'
import { isHighRiskCommand } from '../tools/resolvers'
import type { PermissionRuleInput } from './rules'
import type { PermissionRuleAction, PermissionRuleTrust } from './rules'
import { analyzeShellCommandFailClosed, shellAstSummary } from './shell-ast'

/** PermissionManager 依赖的 ControlManager 表面。 */
export interface PermissionControlHost {
  readonly mode: string
  createAsk(opts: {
    questions: Array<Record<string, unknown>>
    context?: string
    parentCallId?: string | null
    meta?: Record<string, unknown> | null
  }): {
    toDict?: () => Record<string, unknown>
    answers?: Record<string, unknown>
    meta?: Record<string, unknown>
  } & Record<string, unknown>
  consumePlanPermissionToken?(opts: {
    toolName: string
    arguments: Record<string, unknown>
  }): PlanPermissionToken | null
}

interface InteractionLike {
  meta?: Record<string, unknown>
  answers?: Record<string, unknown>
}

export class PermissionManager {
  private readonly controlManager: PermissionControlHost
  readonly policy: PermissionPolicy
  private readonly approvedOnce = new Set<string>()
  private readonly deniedOnce = new Set<string>()

  constructor(
    controlManager: PermissionControlHost,
    opts: { rules?: PermissionRuleInput[] | null } = {},
  ) {
    this.controlManager = controlManager
    this.policy = new PermissionPolicy(undefined, { rules: opts.rules ?? [] })
  }

  assess(
    toolName: string,
    args: Record<string, unknown> | null,
    opts?: { registry?: ToolRegistry | null },
  ): PermissionDecision {
    const argv = args ?? {}
    const fingerprint = fingerprintOf(toolName, argv)
    if (this.approvedOnce.has(fingerprint)) {
      this.approvedOnce.delete(fingerprint)
      return PermissionDecision.allow({
        toolName,
        arguments: argv,
        rule: 'user.approved_once',
        explanation: directDecisionExplanation({
          rule: 'user.approved_once',
          action: 'allow',
          sourceKind: 'user_interaction',
          sourceId: 'permission-answer',
          trust: 'user',
          toolName,
          args: argv,
        }),
      })
    }
    if (this.deniedOnce.has(fingerprint)) {
      this.deniedOnce.delete(fingerprint)
      return PermissionDecision.deny({
        toolName,
        arguments: argv,
        reason: 'user denied this high-risk operation',
        rule: 'user.denied_once',
        explanation: directDecisionExplanation({
          rule: 'user.denied_once',
          action: 'deny',
          sourceKind: 'user_interaction',
          sourceId: 'permission-answer',
          trust: 'user',
          toolName,
          args: argv,
        }),
      })
    }
    if (
      toolName === 'run_command' &&
      isHighRiskCommand(String(argv.command ?? ''))
    ) {
      return this.policy.assess(toolName, argv, this.controlManager.mode, {
        registry: opts?.registry ?? null,
      })
    }
    const planDecision = this.planPermissionTokenDecision(toolName, argv)
    if (planDecision !== null) return planDecision
    return this.policy.assess(toolName, argv, this.controlManager.mode, {
      registry: opts?.registry ?? null,
    })
  }

  requireApproval(
    decision: PermissionDecision,
    opts?: { parentCallId?: string | null; sessionId?: string | null },
  ): string {
    const interaction = this.controlManager.createAsk({
      questions: [
        {
          id: 'permission',
          header: '权限',
          question: `是否允许执行高风险操作 \`${decision.toolName}\`？`,
          options: [
            { label: '允许', description: '批准本次操作，Agent 可继续执行。' },
            {
              label: '拒绝',
              description: '不执行本次操作，让 Agent 改用更安全方案。',
            },
          ],
        },
      ],
      context: this.context(decision),
      parentCallId: opts?.parentCallId ?? null,
      meta: {
        ...controlSessionMeta(opts?.sessionId),
        permission: {
          fingerprint: fingerprintOf(
            decision.toolName,
            decision.arguments ?? {},
          ),
          tool_name: decision.toolName,
          risk: decision.risk,
          reason: decision.reason,
          rule: decision.rule,
          trace: decision.trace.map((item) => ({
            rule: item.rule,
            outcome: item.outcome,
            detail: item.detail,
          })),
          explanation: decision.explanation ?? null,
          arguments: decision.arguments ?? {},
        },
      },
    })
    const dict =
      typeof interaction.toDict === 'function'
        ? interaction.toDict()
        : (interaction as unknown as Record<string, unknown>)
    return makePauseResult(dict)
  }

  recordAnswer(interaction: InteractionLike): void {
    const permission =
      interaction.meta && typeof interaction.meta === 'object'
        ? interaction.meta.permission
        : null
    if (!permission || typeof permission !== 'object') return
    const fingerprint = String(
      (permission as Record<string, unknown>).fingerprint ?? '',
    )
    if (!fingerprint) return
    const answer = interaction.answers?.permission
    let choice = ''
    if (answer && typeof answer === 'object') {
      choice = String(
        (answer as Record<string, unknown>).choice ??
          (answer as Record<string, unknown>).freeform ??
          '',
      )
    } else {
      choice = String(answer ?? '')
    }
    const normalized = choice.trim().toLowerCase()
    if (
      normalized.includes('允许') ||
      normalized.includes('approve') ||
      normalized.includes('allow') ||
      normalized === 'yes'
    ) {
      this.approvedOnce.add(fingerprint)
      this.deniedOnce.delete(fingerprint)
      return
    }
    this.deniedOnce.add(fingerprint)
    this.approvedOnce.delete(fingerprint)
  }

  private context(decision: PermissionDecision): string {
    return [
      'Permission Guard',
      `risk: ${decision.risk}`,
      `rule: ${decision.rule}`,
      `reason: ${decision.reason}`,
      `tool: ${decision.toolName}`,
      'trace:',
      JSON.stringify(
        decision.trace.map((item) => ({
          rule: item.rule,
          outcome: item.outcome,
          detail: item.detail,
        })),
        null,
        2,
      ).slice(0, 1200),
      'explanation:',
      JSON.stringify(decision.explanation ?? {}, null, 2).slice(0, 1600),
      'arguments:',
      JSON.stringify(decision.arguments ?? {}, null, 2).slice(0, 1600),
    ].join('\n')
  }

  private planPermissionTokenDecision(
    toolName: string,
    args: Record<string, unknown>,
  ): PermissionDecision | null {
    const consumer = this.controlManager.consumePlanPermissionToken
    if (typeof consumer !== 'function') return null
    const token = consumer.call(this.controlManager, {
      toolName,
      arguments: args,
    })
    if (token === null || token === undefined) return null
    const trace: PermissionTraceEntry[] = [
      traceEntry(
        'plan.permission_token',
        'allow',
        `${token.planId}:${token.stepId}`,
      ),
    ]
    return PermissionDecision.allow({
      toolName,
      arguments: args,
      rule: 'plan.permission_token',
      trace,
      explanation: directDecisionExplanation({
        rule: 'plan.permission_token',
        action: 'allow',
        sourceKind: 'plan_token',
        sourceId: `${token.planId}:${token.stepId}`,
        trust: 'system',
        toolName,
        args,
      }),
    })
  }
}

function directDecisionExplanation(opts: {
  rule: string
  action: PermissionRuleAction
  sourceKind: string
  sourceId: string
  trust: PermissionRuleTrust
  toolName: string
  args: Record<string, unknown>
}): PermissionDecisionExplanation {
  const source = {
    kind: opts.sourceKind,
    id: opts.sourceId,
    trust: opts.trust,
  }
  const candidate = {
    id: opts.rule,
    action: opts.action,
    matched: true,
    source,
    precedence: `${opts.action}:${opts.trust}:direct`,
  }
  const command = String(opts.args.command ?? '')
  return {
    version: 1,
    candidates: [candidate],
    selected: {
      id: candidate.id,
      action: candidate.action,
      source: { ...candidate.source },
      precedence: candidate.precedence,
    },
    ...(opts.toolName === 'run_command'
      ? { shell: shellAstSummary(analyzeShellCommandFailClosed(command)) }
      : {}),
  }
}

function fingerprintOf(
  toolName: string,
  args: Record<string, unknown>,
): string {
  return `${toolName}:${stableJson(args ?? {})}`
}
