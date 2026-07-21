import type { ModelRouter } from '../model/router'
import type { ToolCallRequest } from '../providers/base'
import type { ToolResultObj } from '../tools/base'
import { redactSensitiveOutput, redactSensitiveValue } from '../util/redaction'
import { CancelledTaskError } from '../runtime/active'

export type ContinuationDecisionKind = 'continue' | 'finalize' | 'pause'

export type ContinuationReasonCode =
  | 'work_remaining'
  | 'verification_remaining'
  | 'ready_to_finalize'
  | 'blocked'
  | 'no_progress'
  | 'user_input_required'
  | 'evaluation_failed'
  | 'budget_exhausted'

export interface TurnContinuationDecision {
  readonly decision: ContinuationDecisionKind
  readonly reasonCode: ContinuationReasonCode
  readonly requestedIterations: 0 | 4 | 8 | 12
  readonly nextActions: string[]
  readonly summary: string
}

export interface TurnContinuationInput {
  readonly taskIntent: string | null
  readonly plan: {
    readonly id: string
    readonly title: string
    readonly status: string
    readonly steps: Array<{
      readonly id: string
      readonly title: string
      readonly status: string
      readonly verificationStatus: string
    }>
  } | null
  readonly todos: Array<{
    readonly id: string
    readonly content: string
    readonly status: string
    readonly planStepId: string | null
  }>
  readonly successfulChanges: string[]
  readonly successfulEvidence: string[]
  readonly recentErrors: string[]
  readonly repeatedReadCount: number
  readonly noProgressIterations: number
  readonly lastIterationHadError: boolean
  readonly totalIterations: number
  readonly evaluationRound: number
  readonly lastAssistantProgress: string
}

export interface TurnContinuationTokenTracker {
  record(
    model: string,
    usage: Record<string, number>,
    opts: Record<string, unknown>,
  ): void
}

export interface TurnContinuationEvaluator {
  evaluate(
    input: TurnContinuationInput,
    opts?: { readonly signal?: AbortSignal | null },
  ): Promise<TurnContinuationDecision>
}

export interface TurnContinuationDiagnostic {
  readonly version: 1
  readonly recordedAt: number
  readonly status: 'response' | 'error'
  readonly provider?: string
  readonly model?: string
  readonly rawOutput?: string | null
  readonly rawOutputHash?: string | null
  readonly error?: string
}

export interface TurnProgressSnapshot {
  readonly meaningfulProgress: number
  readonly successfulChanges: string[]
  readonly successfulEvidence: string[]
  readonly recentErrors: string[]
  readonly repeatedReadCount: number
  readonly noProgressIterations: number
  readonly lastIterationHadError: boolean
}

export class TurnProgressLedger {
  private readonly evidenceFingerprints = new Set<string>()
  private readonly changeFingerprints = new Set<string>()
  private readonly successfulChanges: string[] = []
  private readonly successfulEvidence: string[] = []
  private readonly recentErrors: string[] = []
  private segmentProgress = 0
  private iterationProgress = false
  private repeatedReadCount = 0
  private noProgressIterations = 0
  private iterationHadError = false
  private lastIterationHadError = false

  recordToolResult(
    call: ToolCallRequest,
    result: ToolResultObj,
    opts: { readonly executed: boolean; readonly readOnly: boolean },
  ): void {
    if (!opts.executed || result.isError) {
      this.iterationHadError = true
      this.pushError(`${call.name}:${errorKind(result.summary)}`)
      return
    }
    const argumentsFingerprint = digest(stableJson(call.arguments))
    if (!opts.readOnly) {
      const changeFingerprint = digest(
        `${call.name}:${argumentsFingerprint}:${result.summary}`,
      )
      if (this.changeFingerprints.has(changeFingerprint)) return
      this.changeFingerprints.add(changeFingerprint)
      this.pushUnique(
        this.successfulChanges,
        toolProgressLabel(call, changeFingerprint),
      )
      this.markProgress()
      return
    }
    const evidenceFingerprint = digest(
      `${call.name}:${argumentsFingerprint}:${result.summary}`,
    )
    if (this.evidenceFingerprints.has(evidenceFingerprint)) {
      this.repeatedReadCount += 1
      return
    }
    this.evidenceFingerprints.add(evidenceFingerprint)
    this.pushUnique(
      this.successfulEvidence,
      toolProgressLabel(call, evidenceFingerprint),
    )
    this.markProgress()
  }

  finishIteration(): void {
    if (this.iterationProgress) this.noProgressIterations = 0
    else this.noProgressIterations += 1
    this.iterationProgress = false
    this.lastIterationHadError = this.iterationHadError
    this.iterationHadError = false
  }

  snapshot(): TurnProgressSnapshot {
    return {
      meaningfulProgress: this.segmentProgress,
      successfulChanges: [...this.successfulChanges],
      successfulEvidence: [...this.successfulEvidence],
      recentErrors: [...this.recentErrors],
      repeatedReadCount: this.repeatedReadCount,
      noProgressIterations: this.noProgressIterations,
      lastIterationHadError: this.lastIterationHadError,
    }
  }

  beginContinuationSegment(): void {
    this.segmentProgress = 0
    this.noProgressIterations = 0
  }

  private markProgress(): void {
    this.segmentProgress += 1
    this.iterationProgress = true
  }

  private pushError(value: string): void {
    this.recentErrors.push(redactSensitiveOutput(value).slice(0, 240))
    if (this.recentErrors.length > 10) this.recentErrors.shift()
  }

  private pushUnique(target: string[], value: string): void {
    if (!target.includes(value)) target.push(value)
    if (target.length > 32) target.shift()
  }
}

export class ModelTurnContinuationEvaluator {
  constructor(
    private readonly modelRouter: Pick<ModelRouter, 'route'>,
    private readonly options: {
      readonly timeoutMs?: number
      readonly tokenTracker?: TurnContinuationTokenTracker | null
      readonly diagnosticSink?: (
        diagnostic: TurnContinuationDiagnostic,
      ) => void | Promise<void>
    } = {},
  ) {
    void this.modelRouter
    void this.options
  }

  async evaluate(
    input: TurnContinuationInput,
    opts: { readonly signal?: AbortSignal | null } = {},
  ): Promise<TurnContinuationDecision> {
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (opts.signal?.aborted) controller.abort()
    else opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.trunc(this.options.timeoutMs ?? 8_000)),
    )
    try {
      const route = this.modelRouter.route(
        'turn_continuation_evaluator',
        null,
        input.taskIntent ?? '',
      )
      const response = await Promise.race([
        route.snapshot.provider.chat({
          messages: [
            {
              role: 'system',
              content: CONTINUATION_EVALUATOR_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: continuationPayload(input),
            },
          ],
          tools: null,
          model: route.snapshot.model,
          maxTokens: 256,
          temperature: 0,
          reasoningEffort: null,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('turn continuation evaluator timeout')),
            { once: true },
          )
        }),
      ])
      if (response.usage && Object.keys(response.usage).length) {
        this.options.tokenTracker?.record(
          String(route.snapshot.model ?? ''),
          response.usage,
          {
            provider: String(route.snapshot.providerName ?? 'unknown'),
            usageType: 'turn_continuation_evaluator',
            modelEntryId: String(route.snapshot.modelEntryId ?? 'unknown'),
            routeReason: 'turn_continuation_evaluator',
          },
        )
      }
      await this.writeDiagnostic({
        version: 1,
        recordedAt: Date.now() / 1000,
        status: 'response',
        provider: String(route.snapshot.providerName ?? 'unknown'),
        model: String(route.snapshot.model ?? ''),
        rawOutput: redactEvaluatorText(String(response.content ?? '')).slice(
          0,
          2_000,
        ),
        rawOutputHash: response.content
          ? digest(String(response.content))
          : null,
      })
      return parseContinuationDecision(response.content)
    } catch (error) {
      await this.writeDiagnostic({
        version: 1,
        recordedAt: Date.now() / 1000,
        status: 'error',
        error: redactSensitiveOutput(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 500),
      })
      if (opts.signal?.aborted) throw new CancelledTaskError('turn')
      return evaluationFailedDecision()
    } finally {
      clearTimeout(timeout)
      opts.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  private async writeDiagnostic(
    diagnostic: TurnContinuationDiagnostic,
  ): Promise<void> {
    try {
      await this.options.diagnosticSink?.(diagnostic)
    } catch {
      // Diagnostics are private best-effort evidence and never alter execution.
    }
  }
}

const MAX_EVALUATOR_INPUT_CHARS = 8_000
const MAX_SUMMARY_CHARS = 500
const MAX_ACTION_CHARS = 240
const MAX_ACTIONS = 3

const CONTINUATION_EVALUATOR_SYSTEM_PROMPT =
  'Evaluate whether an agent turn should continue, finalize, or pause. ' +
  'Use only the supplied authoritative state and progress facts. ' +
  'Never claim completion when a Plan step or required verification remains. ' +
  'Reply with one JSON object and no markdown: ' +
  '{"decision":"continue|finalize|pause","reasonCode":"work_remaining|verification_remaining|ready_to_finalize|blocked|no_progress|user_input_required","requestedIterations":4|8|12,"nextActions":["..."],"summary":"..."}. ' +
  'A continue decision requires one to three concrete non-duplicative next actions.'

const MODEL_REASON_CODES = new Set<ContinuationReasonCode>([
  'work_remaining',
  'verification_remaining',
  'ready_to_finalize',
  'blocked',
  'no_progress',
  'user_input_required',
])

function parseContinuationDecision(
  content: string | null,
): TurnContinuationDecision {
  if (!content || !content.trim()) return evaluationFailedDecision()
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return evaluationFailedDecision()
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return evaluationFailedDecision()
  const item = value as Record<string, unknown>
  const keys = Object.keys(item).sort()
  if (
    keys.join('|') !==
    [
      'decision',
      'nextActions',
      'reasonCode',
      'requestedIterations',
      'summary',
    ].join('|')
  )
    return evaluationFailedDecision()
  if (
    typeof item.decision !== 'string' ||
    typeof item.reasonCode !== 'string' ||
    typeof item.requestedIterations !== 'number' ||
    typeof item.summary !== 'string' ||
    !Array.isArray(item.nextActions) ||
    !item.nextActions.every((action) => typeof action === 'string')
  )
    return evaluationFailedDecision()
  const decision = item.decision as ContinuationDecisionKind
  const reasonCode = item.reasonCode as ContinuationReasonCode
  const requestedIterations = item.requestedIterations
  const summary = redactEvaluatorText(item.summary).trim()
  const actions = item.nextActions
    .slice(0, MAX_ACTIONS)
    .map((action) =>
      redactEvaluatorText(action).trim().slice(0, MAX_ACTION_CHARS),
    )
    .filter(Boolean)
  const validSemanticPair =
    (decision === 'continue' &&
      ['work_remaining', 'verification_remaining'].includes(reasonCode)) ||
    (decision === 'finalize' && reasonCode === 'ready_to_finalize') ||
    (decision === 'pause' &&
      ['blocked', 'no_progress', 'user_input_required'].includes(reasonCode))
  if (
    !['continue', 'finalize', 'pause'].includes(decision) ||
    !MODEL_REASON_CODES.has(reasonCode) ||
    !Number.isInteger(requestedIterations) ||
    requestedIterations < 4 ||
    (requestedIterations <= 12 && ![4, 8, 12].includes(requestedIterations)) ||
    !validSemanticPair ||
    !summary ||
    actions.length === 0
  )
    return evaluationFailedDecision()
  return {
    decision,
    reasonCode,
    requestedIterations: Math.min(12, requestedIterations) as 4 | 8 | 12,
    nextActions: actions,
    summary: summary.slice(0, MAX_SUMMARY_CHARS),
  }
}

function continuationPayload(input: TurnContinuationInput): string {
  const payload = redactSensitiveValue({
    taskIntent: String(input.taskIntent ?? '').slice(0, 800),
    plan: input.plan
      ? {
          id: input.plan.id.slice(0, 160),
          title: input.plan.title.slice(0, 240),
          status: input.plan.status.slice(0, 64),
          steps: input.plan.steps.slice(0, 48).map((step) => ({
            id: step.id.slice(0, 160),
            title: step.title.slice(0, 160),
            status: step.status.slice(0, 64),
            verificationStatus: step.verificationStatus.slice(0, 64),
          })),
        }
      : null,
    todos: input.todos.slice(0, 48).map((todo) => ({
      id: todo.id.slice(0, 160),
      content: todo.content.slice(0, 160),
      status: todo.status.slice(0, 64),
      planStepId: todo.planStepId?.slice(0, 160) ?? null,
    })),
    successfulChanges: input.successfulChanges
      .slice(0, 32)
      .map((item) => item.slice(0, 240)),
    successfulEvidence: input.successfulEvidence
      .slice(0, 32)
      .map((item) => item.slice(0, 240)),
    recentErrors: input.recentErrors
      .slice(-10)
      .map((item) => item.slice(0, 240)),
    repeatedReadCount: boundedCount(input.repeatedReadCount),
    noProgressIterations: boundedCount(input.noProgressIterations),
    lastIterationHadError: input.lastIterationHadError === true,
    totalIterations: boundedCount(input.totalIterations),
    evaluationRound: boundedCount(input.evaluationRound),
    lastAssistantProgress: input.lastAssistantProgress.slice(0, 400),
  }) as Record<string, unknown>
  let serialized = JSON.stringify(payload)
  const plan = payload.plan as { steps?: unknown[] } | null
  const shrinkable = [
    payload.successfulEvidence as unknown[],
    payload.successfulChanges as unknown[],
    payload.todos as unknown[],
    plan?.steps ?? [],
  ]
  while (serialized.length > MAX_EVALUATOR_INPUT_CHARS) {
    const target = shrinkable.find((items) => items.length > 0)
    if (!target) break
    target.pop()
    serialized = JSON.stringify(payload)
  }
  if (serialized.length > MAX_EVALUATOR_INPUT_CHARS) {
    payload.taskIntent = String(payload.taskIntent ?? '').slice(0, 200)
    payload.lastAssistantProgress = String(
      payload.lastAssistantProgress ?? '',
    ).slice(0, 120)
    serialized = JSON.stringify(payload)
  }
  if (serialized.length > MAX_EVALUATOR_INPUT_CHARS)
    serialized = JSON.stringify({
      taskIntent: String(payload.taskIntent ?? '').slice(0, 100),
      plan:
        plan && payload.plan
          ? {
              id: String((payload.plan as Record<string, unknown>).id ?? ''),
              status: String(
                (payload.plan as Record<string, unknown>).status ?? '',
              ),
              steps: [],
            }
          : null,
      todos: [],
      successfulChanges: [],
      successfulEvidence: [],
      recentErrors: [],
      repeatedReadCount: payload.repeatedReadCount,
      noProgressIterations: payload.noProgressIterations,
      lastIterationHadError: payload.lastIterationHadError,
      totalIterations: payload.totalIterations,
      evaluationRound: payload.evaluationRound,
      lastAssistantProgress: '',
    })
  return serialized
}

function evaluationFailedDecision(): TurnContinuationDecision {
  return {
    decision: 'pause',
    reasonCode: 'evaluation_failed',
    requestedIterations: 0,
    nextActions: [],
    summary: '续跑评估不可用，执行已安全暂停。',
  }
}

function boundedCount(value: number): number {
  return Math.max(0, Math.min(1_000_000, Math.trunc(Number(value) || 0)))
}

function redactEvaluatorText(value: string): string {
  return redactSensitiveOutput(value)
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /\b(token|secret|password|api[_-]?key)\s+[A-Za-z0-9_.:/+-]{4,}/gi,
      '$1 [REDACTED]',
    )
}

function errorKind(value: string): string {
  const text = redactSensitiveOutput(String(value ?? 'error'))
    .split(/\r?\n/, 1)[0]
    ?.trim()
    .toLowerCase()
  if (!text) return 'error'
  if (text.includes('plan_todo_binding_rejected'))
    return 'plan_todo_binding_rejected'
  if (text.includes('schema')) return 'schema'
  if (text.includes('permission')) return 'permission'
  if (text.includes('timeout')) return 'timeout'
  if (text.includes('non-zero')) return 'non_zero'
  return digest(text)
}

function toolProgressLabel(call: ToolCallRequest, fingerprint: string): string {
  const targets = [
    'path',
    'file_path',
    'old_path',
    'new_path',
    'target',
    'destination',
  ]
    .map((key) => call.arguments[key])
    .filter((value): value is string => typeof value === 'string' && !!value)
    .map((value) => redactSensitiveOutput(value).slice(0, 240))
  return targets.length
    ? `${call.name}:${targets.join(' -> ')}`
    : `${call.name}:${fingerprint}`
}

function digest(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}
