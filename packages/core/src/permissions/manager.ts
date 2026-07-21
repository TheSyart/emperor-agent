/**
 * PermissionManager (MIG-CTRL-017)。对齐 Python `agent/permissions/manager.py`。
 * approve/deny-once 指纹 + plan token；高风险 run_command 在 token 前先评估 (PE-13)。
 */
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolRegistry } from '../tools/registry'
import { controlSessionMeta, makePauseResult } from '../control/tools'
import { newInteractionId } from '../control/models'
import {
  PermissionDecision,
  permissionArgumentHash,
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
import {
  ModelPermissionSemanticClassifier,
  type PermissionSemanticClassifier,
} from './semantic-classifier'
import { redactSensitiveOutput } from '../util/redaction'
import type { ModelRouter } from '../model/router'
import {
  PermissionRequestStore,
  type PermissionRequestOutcome,
} from './request-store'

/** PermissionManager 依赖的 ControlManager 表面。 */
export interface PermissionControlHost {
  readonly mode: string
  setMode?(mode: string): unknown
  createAsk(opts: {
    interactionId?: string
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

export interface PermissionAssessmentCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface PermissionAssessmentOptions {
  registry?: ToolRegistry | null
  sessionId?: string | null
  turnId?: string | null
  workspaceRoot?: string | null
  cwd?: string | null
  taskIntent?: string | null
  authorizationId?: string | null
}

export interface PermissionBatchOperation {
  callId: string
  fingerprint: string
  decision: PermissionDecision
}

export interface PermissionBatchAssessment {
  allowed: boolean
  requiresApproval: boolean
  risk: string
  reason: string
  rule: string
  decisions: PermissionDecision[]
  operations: PermissionBatchOperation[]
  authorizationId: string | null
}

export interface PermissionAnswerResult {
  requestId: string
  outcome: PermissionRequestOutcome
}

export class PermissionManager {
  private readonly controlManager: PermissionControlHost
  readonly policy: PermissionPolicy
  private readonly requestStore: PermissionRequestStore
  private readonly semanticCache = new Map<string, PermissionDecision>()
  private readonly classifier: PermissionSemanticClassifier | null

  constructor(
    controlManager: PermissionControlHost,
    opts: {
      rules?: PermissionRuleInput[] | null
      classifier?: PermissionSemanticClassifier | null
      modelRouter?: Pick<ModelRouter, 'route'> | null
      stateRoot?: string
    } = {},
  ) {
    this.controlManager = controlManager
    if (!opts.stateRoot)
      throw new Error('PermissionManager stateRoot is required')
    this.requestStore = new PermissionRequestStore(opts.stateRoot)
    this.requestStore.cleanup()
    this.policy = new PermissionPolicy(undefined, { rules: opts.rules ?? [] })
    this.classifier =
      opts.classifier ??
      (opts.modelRouter
        ? new ModelPermissionSemanticClassifier(opts.modelRouter)
        : null)
  }

  async assess(
    toolName: string,
    args: Record<string, unknown> | null,
    opts?: PermissionAssessmentOptions,
  ): Promise<PermissionDecision> {
    const batch = await this.assessBatch(
      [{ id: 'single', name: toolName, arguments: args ?? {} }],
      opts,
    )
    return batch.decisions[0]!
  }

  async assessBatch(
    calls: PermissionAssessmentCall[],
    opts: PermissionAssessmentOptions = {},
  ): Promise<PermissionBatchAssessment> {
    if (!calls.length) return emptyBatch()
    if (calls.length > 64)
      return deniedBatch(
        calls.map((call) =>
          PermissionDecision.deny({
            toolName: call.name,
            arguments: call.arguments,
            reason: 'permission batch exceeds the 64-operation limit',
            rule: 'permission.batch_limit',
          }),
        ),
        calls,
        opts,
      )

    const decisions: PermissionDecision[] = []
    for (const call of calls)
      decisions.push(await this.assessBase(call.name, call.arguments, opts))

    const hardDeny = decisions.find(
      (decision) => !decision.allowed && !decision.requiresApproval,
    )
    if (hardDeny) return batchFrom(calls, decisions, opts)

    let approvalIndexes = approvalDecisionIndexes(decisions)
    const authorizationId = String(opts.authorizationId ?? '').trim()
    if (authorizationId && approvalIndexes.length) {
      const exact = this.requestStore.consumeExact(
        authorizationId,
        String(opts.sessionId ?? ''),
        approvalIndexes.map((index) => fingerprintOf(calls[index]!, opts)),
      )
      if (exact === 'deny') {
        for (const index of approvalIndexes)
          decisions[index] = answerDecision(
            decisions[index]!,
            'deny',
            authorizationId,
          )
        return batchFrom(calls, decisions, opts, authorizationId)
      }
      if (exact === 'allow') {
        for (const index of approvalIndexes)
          decisions[index] = answerDecision(
            decisions[index]!,
            'allow',
            authorizationId,
          )
        return batchFrom(calls, decisions, opts, authorizationId)
      }
    }

    approvalIndexes = approvalDecisionIndexes(decisions)
    if (approvalIndexes.length === 1) {
      const index = approvalIndexes[0]!
      const decision = decisions[index]!
      const command = String(decision.arguments?.command ?? '')
      if (!(
        decision.toolName === 'run_command' && isHighRiskCommand(command)
      )) {
        const planDecision = this.planPermissionTokenDecision(
          decision.toolName,
          decision.arguments ?? {},
        )
        if (planDecision) decisions[index] = planDecision
      }
    }
    return batchFrom(calls, decisions, opts)
  }

  private async assessBase(
    toolName: string,
    argv: Record<string, unknown>,
    opts: PermissionAssessmentOptions,
  ): Promise<PermissionDecision> {
    const decision = this.policy.assess(
      toolName,
      argv,
      this.controlManager.mode,
      {
        registry: opts.registry ?? null,
        workspaceRoot: opts.workspaceRoot ?? null,
        cwd: opts.cwd ?? null,
      },
    )
    if (decision.rule !== 'mode.smart_auto.semantic_review' || !this.classifier)
      return decision
    const fingerprint = fingerprintOf(
      { id: 'semantic', name: toolName, arguments: argv },
      opts,
    )
    const cacheKey = [
      opts.sessionId ?? '',
      opts.turnId ?? '',
      fingerprint,
    ].join(':')
    const cached = this.semanticCache.get(cacheKey)
    if (cached) return cached
    let classified: 'allow' | 'ask' | null = null
    try {
      classified = await this.classifier.classify({
        toolName,
        arguments: argv,
        shell: decision.explanation?.shell ?? null,
        cwd: opts.cwd ?? null,
        workspaceRoot: opts.workspaceRoot ?? null,
        taskIntent: opts.taskIntent ?? null,
      })
    } catch {
      classified = null
    }
    const resolved =
      classified === 'allow'
        ? PermissionDecision.allow({
            toolName,
            arguments: argv,
            rule: 'mode.smart_auto.semantic_classifier_allow',
            trace: [
              ...decision.trace,
              traceEntry(
                'mode.smart_auto.semantic_classifier_allow',
                'allow',
                'permission classifier returned allow',
              ),
            ],
            explanation: decision.explanation,
          })
        : decision
    if (this.semanticCache.size >= 256)
      this.semanticCache.delete(this.semanticCache.keys().next().value ?? '')
    this.semanticCache.set(cacheKey, resolved)
    return resolved
  }

  requireApproval(
    decision: PermissionDecision,
    opts?: {
      parentCallId?: string | null
      sessionId?: string | null
      workspaceRoot?: string | null
      cwd?: string | null
    },
  ): string {
    const call: PermissionAssessmentCall = {
      id: String(opts?.parentCallId ?? 'single'),
      name: decision.toolName,
      arguments: decision.arguments ?? {},
    }
    return this.requireApprovalBatch(
      batchFrom([call], [decision], opts ?? {}),
      opts,
    )
  }

  requireApprovalBatch(
    batch: PermissionBatchAssessment,
    opts?: {
      parentCallId?: string | null
      sessionId?: string | null
      workspaceRoot?: string | null
      cwd?: string | null
    },
  ): string {
    const approvalOperations = batch.operations.filter(
      (operation) => operation.decision.requiresApproval,
    )
    if (!approvalOperations.length)
      throw new Error('permission batch has no operations requiring approval')
    const requestId = `permission_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const interactionId = newInteractionId('ask')
    const sessionId = String(opts?.sessionId ?? '')
    if (!sessionId) throw new Error('permission approval requires a session id')
    const createdAt = Date.now()
    this.requestStore.create({
      version: 1,
      id: requestId,
      interactionId,
      sessionId,
      status: 'waiting',
      outcome: null,
      createdAt,
      expiresAt: createdAt + 30 * 60 * 1000,
      operations: approvalOperations.map((operation, index) => ({
        id: `operation_${index + 1}`,
        fingerprint: operation.fingerprint,
        toolName: operation.decision.toolName,
        argumentsHash: permissionArgumentHash(
          operation.decision.arguments ?? {},
        ),
        arguments: operation.decision.arguments ?? {},
        remainingUses: 1,
        risk: operation.decision.risk,
        rule: operation.decision.rule,
        trace: operation.decision.trace,
        explanation: operation.decision.explanation ?? null,
      })),
    })
    let interaction:
      | (ReturnType<PermissionControlHost['createAsk']> &
          Record<string, unknown>)
      | null = null
    try {
      interaction = this.controlManager.createAsk({
        interactionId,
        questions: [
          {
            id: 'permission',
            header: '权限',
            question:
              approvalOperations.length === 1
                ? '是否允许执行这项操作？'
                : `是否允许执行以下 ${approvalOperations.length} 项操作？`,
            options: [
              {
                id: 'allow_once',
                label: '允许本次',
                description: '仅批准当前列出的精确操作。',
              },
              {
                id: 'deny',
                label: '拒绝',
                description: '不执行本批操作，让 Agent 改用其他方案。',
              },
              {
                id: 'allow_and_full_access',
                label: '允许并切换到完全访问',
                description: '批准当前操作，并让后续普通操作不再请求权限。',
              },
            ],
          },
        ],
        context: this.batchContext(approvalOperations),
        parentCallId: opts?.parentCallId ?? null,
        meta: {
          ...controlSessionMeta(sessionId),
          interaction_type: 'permission',
          permission: {
            version: 2,
            request_id: requestId,
            operation_count: approvalOperations.length,
            operations: approvalOperations.map((operation, index) => ({
              operation_id: `operation_${index + 1}`,
              tool_name: operation.decision.toolName,
              risk: operation.decision.risk,
              reason: redactSensitiveOutput(operation.decision.reason).slice(
                0,
                240,
              ),
              summary: safeCommandSummary(operation.decision, {
                workspaceRoot: opts?.workspaceRoot ?? null,
                cwd: opts?.cwd ?? null,
              }),
            })),
          },
        },
      })
    } catch (error) {
      this.requestStore.cancel(requestId)
      throw error
    }
    const dict =
      typeof interaction.toDict === 'function'
        ? interaction.toDict()
        : (interaction as unknown as Record<string, unknown>)
    return makePauseResult(dict)
  }

  recordAnswer(interaction: InteractionLike): PermissionAnswerResult | null {
    const permission =
      interaction.meta && typeof interaction.meta === 'object'
        ? interaction.meta.permission
        : null
    if (!permission || typeof permission !== 'object') return null
    const data = permission as Record<string, unknown>
    const requestId = String(data.request_id ?? '').trim()
    if (!requestId) return null
    const answer = interaction.answers?.permission
    const answerData =
      answer && typeof answer === 'object' && !Array.isArray(answer)
        ? (answer as Record<string, unknown>)
        : {}
    const optionId = String(
      answerData.option_id ?? answerData.optionId ?? '',
    ).trim()
    const choice = String(answerData.choice ?? '').trim()
    const outcome = permissionOutcome(optionId, choice)
    this.requestStore.resolve(requestId, outcome)
    if (outcome === 'allow_and_full_access')
      this.controlManager.setMode?.('full_access')
    return { requestId, outcome }
  }

  cancelRequest(interaction: InteractionLike): void {
    const permission =
      interaction.meta && typeof interaction.meta === 'object'
        ? interaction.meta.permission
        : null
    if (!permission || typeof permission !== 'object') return
    const requestId = String(
      (permission as Record<string, unknown>).request_id ?? '',
    ).trim()
    if (requestId) this.requestStore.cancel(requestId)
  }

  isWaitingRequestRecoverable(interaction: InteractionLike): boolean {
    const permission =
      interaction.meta && typeof interaction.meta === 'object'
        ? interaction.meta.permission
        : null
    if (!permission || typeof permission !== 'object') return false
    const requestId = String(
      (permission as Record<string, unknown>).request_id ?? '',
    ).trim()
    if (!requestId) return false
    const request = this.requestStore.get(requestId)
    if (!request || request.status !== 'waiting') return false
    const interactionId = String(
      (interaction as InteractionLike & { id?: unknown }).id ?? '',
    ).trim()
    const sessionId = String(interaction.meta?.control_session_id ?? '').trim()
    return (
      Boolean(interactionId) &&
      request.interactionId === interactionId &&
      Boolean(sessionId) &&
      request.sessionId === sessionId
    )
  }

  private batchContext(operations: PermissionBatchOperation[]): string {
    const count = operations.length
    return count === 1
      ? '这项操作需要你的权限确认。'
      : `以下 ${count} 项精确操作需要一次统一权限确认。`
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

function safeCommandSummary(
  decision: PermissionDecision,
  context: {
    workspaceRoot: string | null
    cwd: string | null
  },
): string {
  const args = decision.arguments ?? {}
  if (decision.toolName !== 'run_command') {
    const targets = operationPathEntries(args)
    if (targets.length) {
      const base = canonicalPath(context.cwd ?? context.workspaceRoot)
      const workspaceRoot = canonicalPath(context.workspaceRoot)
      const rendered = targets.map(({ key, value }) => ({
        key,
        value: safeDisplayPath(value, base, workspaceRoot),
      }))
      const details =
        rendered.length === 1
          ? rendered[0]!.value
          : rendered.map(({ key, value }) => `${key}=${value}`).join(' ')
      return `${decision.toolName} ${details}`
    }
  }
  const raw =
    decision.toolName === 'run_command'
      ? String(args.command ?? '')
      : `${decision.toolName} ${stableJson(args)}`
  const summary = redactSensitiveOutput(raw).replace(/\s+/g, ' ').trim()
  return summary.slice(0, 320) || decision.toolName
}

function operationPathEntries(
  args: Record<string, unknown>,
): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = []
  for (const [key, value] of Object.entries(args)) {
    if (
      !/(?:^|_)(?:path|file|directory|target)s?$|^(?:source|destination)$/i.test(
        key,
      )
    )
      continue
    for (const item of Array.isArray(value) ? value : [value]) {
      const text = String(item ?? '')
      if (text.length > 0) entries.push({ key, value: text })
    }
  }
  return entries
}

function safeDisplayPath(
  value: string,
  base: string,
  workspaceRoot: string,
): string {
  const absolute = resolve(base || workspaceRoot || process.cwd(), value)
  if (workspaceRoot) {
    const workspaceRelative = relative(workspaceRoot, absolute)
    const insideWorkspace =
      workspaceRelative === '' ||
      (!isAbsolute(workspaceRelative) &&
        workspaceRelative !== '..' &&
        !workspaceRelative.startsWith(`..${sep}`))
    if (insideWorkspace)
      return sanitizePathLabel(workspaceRelative || '.', absolute)
  }
  return `[external]/${sanitizePathLabel(
    basename(absolute) || 'target',
    absolute,
    true,
  )}`
}

function sanitizePathLabel(
  value: string,
  canonicalPathValue: string,
  forceHash = false,
): string {
  const sanitized = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, '�').trim()
  const characters = [...sanitized]
  const changed = sanitized !== value
  const truncated = characters.length > 240
  if (!forceHash && !changed && !truncated) return sanitized
  const hash = createHash('sha256')
    .update(canonicalPathValue, 'utf8')
    .digest('hex')
    .slice(0, 10)
  const suffix = truncated ? `…#${hash}` : ` #${hash}`
  const visibleBudget = Math.max(1, 240 - [...suffix].length)
  const visible = characters.slice(0, visibleBudget).join('') || '[hidden]'
  return `${visible}${suffix}`
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

function permissionOutcome(
  optionId: string,
  choice: string,
): PermissionRequestOutcome {
  if (optionId === 'allow_once' || (!optionId && choice === '允许本次'))
    return 'allow_once'
  if (
    optionId === 'allow_and_full_access' ||
    (!optionId && choice === '允许并切换到完全访问')
  )
    return 'allow_and_full_access'
  return 'deny'
}

function fingerprintOf(
  call: PermissionAssessmentCall,
  opts: PermissionAssessmentOptions,
): string {
  const workspaceRoot = canonicalPath(opts.workspaceRoot)
  const cwd = canonicalPath(opts.cwd ?? opts.workspaceRoot)
  const payload = {
    sessionId: String(opts.sessionId ?? ''),
    toolName: call.name,
    arguments: call.arguments ?? {},
    workspaceRoot,
    cwd,
    targets: canonicalTargets(call.arguments ?? {}, cwd || workspaceRoot),
  }
  return createHash('sha256').update(stableJson(payload), 'utf8').digest('hex')
}

function canonicalPath(value: string | null | undefined): string {
  const text = String(value ?? '').trim()
  return text ? resolve(text) : ''
}

function canonicalTargets(
  args: Record<string, unknown>,
  base: string,
): string[] {
  const paths: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (!/(?:^|_)(?:path|file|directory|target)s?$/i.test(key)) continue
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      const text = String(item ?? '').trim()
      if (!text) continue
      paths.push(resolve(base || process.cwd(), text))
    }
  }
  return paths.sort()
}

function approvalDecisionIndexes(decisions: PermissionDecision[]): number[] {
  return decisions.flatMap((decision, index) =>
    decision.requiresApproval ? [index] : [],
  )
}

function batchFrom(
  calls: PermissionAssessmentCall[],
  decisions: PermissionDecision[],
  opts: PermissionAssessmentOptions,
  authorizationId: string | null = null,
): PermissionBatchAssessment {
  const requiresApproval = decisions.some(
    (decision) => decision.requiresApproval,
  )
  const allowed = decisions.every((decision) => decision.allowed)
  const primary =
    decisions.find((decision) => !decision.allowed) ?? decisions[0]!
  return {
    allowed,
    requiresApproval,
    risk: primary?.risk ?? 'low',
    reason: primary?.reason ?? '',
    rule: primary?.rule ?? '',
    decisions,
    operations: decisions.map((decision, index) => ({
      callId: calls[index]?.id ?? `call_${index + 1}`,
      fingerprint: fingerprintOf(calls[index]!, opts),
      decision,
    })),
    authorizationId,
  }
}

function deniedBatch(
  decisions: PermissionDecision[],
  calls: PermissionAssessmentCall[],
  opts: PermissionAssessmentOptions,
): PermissionBatchAssessment {
  return batchFrom(calls, decisions, opts)
}

function emptyBatch(): PermissionBatchAssessment {
  return {
    allowed: true,
    requiresApproval: false,
    risk: 'low',
    reason: '',
    rule: '',
    decisions: [],
    operations: [],
    authorizationId: null,
  }
}

function answerDecision(
  decision: PermissionDecision,
  outcome: 'allow' | 'deny',
  requestId: string,
): PermissionDecision {
  const toolName = decision.toolName
  const args = decision.arguments ?? {}
  return outcome === 'allow'
    ? PermissionDecision.allow({
        toolName,
        arguments: args,
        rule: 'user.approved_once',
        trace: [
          ...decision.trace,
          traceEntry('user.approved_once', 'allow', requestId),
        ],
        explanation: directDecisionExplanation({
          rule: 'user.approved_once',
          action: 'allow',
          sourceKind: 'user_interaction',
          sourceId: requestId,
          trust: 'user',
          toolName,
          args,
        }),
      })
    : PermissionDecision.deny({
        toolName,
        arguments: args,
        reason: 'user denied this exact operation batch',
        rule: 'user.denied_once',
        trace: [
          ...decision.trace,
          traceEntry('user.denied_once', 'deny', requestId),
        ],
        explanation: directDecisionExplanation({
          rule: 'user.denied_once',
          action: 'deny',
          sourceKind: 'user_interaction',
          sourceId: requestId,
          trust: 'user',
          toolName,
          args,
        }),
      })
}
