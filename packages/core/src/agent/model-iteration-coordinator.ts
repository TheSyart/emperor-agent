import {
  TransitionReason,
  beginIteration,
  emptyResponseRetry,
  lengthRecovery,
  makeQueryState,
  markCompleted,
  markPaused,
  maxTurnsReached,
  nearMaxTurns,
  todoFollowup,
  toolFollowup,
  type QueryState,
  type QueryTransition,
} from './query-state'
import type { TurnProgressSnapshot } from './turn-progress'

export interface ModelIterationSamplingPort<TRequest, TResponse> {
  sample(request: TRequest): Promise<TResponse>
}

export interface ModelIterationProgressPauseDecision {
  reasonCode: 'no_progress' | 'verification_remaining' | 'blocked'
  nextActions: string[]
  summary: string
}

export type ModelIterationProgressDecision =
  | { kind: 'continue' }
  | { kind: 'correction'; message: string }
  | { kind: 'pause'; decision: ModelIterationProgressPauseDecision }

export class ModelIterationCoordinator<TRequest, TResponse> {
  private queryState: QueryState
  private readonly maxEmptyRetries: number
  private readonly maxLengthRecoveries: number
  private readonly samplingPort: ModelIterationSamplingPort<TRequest, TResponse>
  private noProgressCorrectionProgress = -1
  private lastStrategyCorrection = ''

  constructor(input: {
    turnId: string | null
    maxTurns: number | null
    maxEmptyRetries: number
    maxLengthRecoveries: number
    samplingPort: ModelIterationSamplingPort<TRequest, TResponse>
  }) {
    this.queryState = makeQueryState({
      turnId: input.turnId,
      maxTurns: input.maxTurns,
    })
    this.maxEmptyRetries = input.maxEmptyRetries
    this.maxLengthRecoveries = input.maxLengthRecoveries
    this.samplingPort = input.samplingPort
  }

  get state(): Readonly<QueryState> {
    return Object.freeze({ ...this.queryState })
  }

  sample(request: TRequest): Promise<TResponse> {
    return this.samplingPort.sample(request)
  }

  evaluateProgress(
    snapshot: TurnProgressSnapshot,
    nextActions: string[],
  ): ModelIterationProgressDecision {
    if (this.queryState.maxTurns !== null) return { kind: 'continue' }
    const strategyKey = String(snapshot.repeatedFailureStrategyKey ?? '')
    const strategyCount = Math.max(
      0,
      Number(snapshot.repeatedFailureStrategyCount ?? 0),
    )
    if (!strategyKey) this.lastStrategyCorrection = ''
    if (
      strategyKey &&
      strategyCount >= 3 &&
      this.lastStrategyCorrection !== strategyKey
    ) {
      this.lastStrategyCorrection = strategyKey
      return {
        kind: 'correction',
        message:
          '[CONTROL:REPEATED_STRATEGY_FAILURE]\n同一策略连续失败 3 次或以上。停止原样重试；先诊断失败种类，改用不同来源、不同工具或明确报告阻塞。401、404、权限拒绝和重定向都不是任务进展。',
      }
    }
    if (snapshot.noProgressIterations >= 12) {
      return {
        kind: 'pause',
        decision: {
          reasonCode: 'no_progress',
          nextActions,
          summary:
            '连续 12 次模型迭代没有形成新的有效进展，Core 已暂停当前执行以阻止重复循环。',
        },
      }
    }
    if (
      snapshot.noProgressIterations >= 6 &&
      this.noProgressCorrectionProgress !== snapshot.meaningfulProgress
    ) {
      this.noProgressCorrectionProgress = snapshot.meaningfulProgress
      return {
        kind: 'correction',
        message:
          '[CONTROL:NO_PROGRESS_CORRECTION]\n连续 6 次模型迭代没有形成新的有效进展。停止重复读取、重复命令和重复错误；选择新的验证路径并执行一个可验证的新动作。若连续 12 次仍无进展，Core 将暂停本回合。',
      }
    }
    return { kind: 'continue' }
  }

  beginIteration(): QueryTransition {
    return this.apply(beginIteration(this.queryState))
  }

  maxTurnsReached(): QueryTransition | null {
    return this.applyNullable(maxTurnsReached(this.queryState))
  }

  nearMaxTurns(): QueryTransition | null {
    return this.applyNullable(nearMaxTurns(this.queryState))
  }

  toolFollowup(): QueryTransition {
    return this.apply(toolFollowup(this.queryState))
  }

  emptyResponseRetry(): QueryTransition | null {
    return this.applyNullable(
      emptyResponseRetry(this.queryState, {
        maxRetries: this.maxEmptyRetries,
      }),
    )
  }

  lengthRecovery(reply: string): QueryTransition | null {
    return this.applyNullable(
      lengthRecovery(this.queryState, reply, {
        maxRetries: this.maxLengthRecoveries,
      }),
    )
  }

  todoFollowup(input: {
    unfinishedText: string
    unfinishedCount: number
    maxContinuations?: number | null
  }): QueryTransition | null {
    return this.applyNullable(todoFollowup(this.queryState, input))
  }

  pause(reason: TransitionReason): QueryTransition {
    return this.apply(markPaused(this.queryState, reason))
  }

  complete(): QueryTransition {
    return this.apply(markCompleted(this.queryState))
  }

  private apply(transition: QueryTransition): QueryTransition {
    this.queryState = transition.nextState
    return transition
  }

  private applyNullable(
    transition: QueryTransition | null,
  ): QueryTransition | null {
    return transition === null ? null : this.apply(transition)
  }
}
