import type { TodoContinuationIntent } from './query-state'

type Message = Record<string, unknown>
type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>

export interface TurnPlanBinding {
  readonly available: boolean
  readonly planId: string | null
}

export type PlanVerificationFollowup = Record<string, unknown>

export interface PlanTurnCoordinatorPorts {
  resumePlanExecution(turnId: string): unknown | null
  assessEntryDecision(history: readonly Message[]): unknown
  executablePlanBinding(): TurnPlanBinding
  shouldEnforcePlanFinal(): boolean
  independentVerificationFollowup(): PlanVerificationFollowup | null
  honestyFollowup(): Message | null
  pauseForExecutionDecision(
    history: Message[],
    emit: StreamEmitter | null,
  ): Promise<void>
  appendExecutionDisclosure(reply: string): string
  markIndependentVerificationDelivered(): void
}

export class PlanTurnCoordinator {
  private readonly turnId: string | null
  private readonly continuation: TodoContinuationIntent
  private readonly ports: PlanTurnCoordinatorPorts
  private binding: TurnPlanBinding = Object.freeze({
    available: true,
    planId: null,
  })
  private planFinalCorrections = 0

  constructor(input: {
    turnId: string | null
    continuation: TodoContinuationIntent
    ports: PlanTurnCoordinatorPorts
  }) {
    this.turnId = input.turnId
    this.continuation = input.continuation
    this.ports = input.ports
  }

  enter(history: readonly Message[]): {
    resumedPlan: unknown | null
    entryDecision: unknown
    binding: TurnPlanBinding
  } {
    const resumedPlan =
      this.continuation !== 'none' && this.turnId
        ? this.ports.resumePlanExecution(this.turnId)
        : null
    const entryDecision = this.ports.assessEntryDecision(history)
    this.binding = Object.freeze(
      this.continuation === 'none'
        ? { available: true, planId: null }
        : { ...this.ports.executablePlanBinding() },
    )
    return { resumedPlan, entryDecision, binding: this.binding }
  }

  planSubmissionDecision():
    | { kind: 'none' }
    | { kind: 'followup'; attempt: number }
    | { kind: 'exhausted' } {
    if (!this.ports.shouldEnforcePlanFinal()) return { kind: 'none' }
    if (this.planFinalCorrections >= 1) return { kind: 'exhausted' }
    this.planFinalCorrections += 1
    return { kind: 'followup', attempt: this.planFinalCorrections }
  }

  independentVerificationFollowup(): PlanVerificationFollowup | null {
    return this.ports.independentVerificationFollowup()
  }

  honestyFollowup(): Message | null {
    return this.binding.planId === null ? null : this.ports.honestyFollowup()
  }

  pauseForExecutionDecision(
    history: Message[],
    emit: StreamEmitter | null,
  ): Promise<void> {
    return this.ports.pauseForExecutionDecision(history, emit)
  }

  appendExecutionDisclosure(reply: string): string {
    return this.ports.appendExecutionDisclosure(reply)
  }

  markIndependentVerificationDelivered(): void {
    this.ports.markIndependentVerificationDelivered()
  }
}
