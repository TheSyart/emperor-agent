type Message = Record<string, unknown>

export interface TurnFinalizerStopDecision {
  readonly decision: 'passthrough' | 'allow' | 'deny' | 'ask'
  readonly reason: string
  readonly continue?: boolean
  readonly stopReason?: string
}

export interface TurnFinalizerPorts {
  planSubmissionDecision():
    | { kind: 'none' }
    | { kind: 'followup'; attempt: number }
    | { kind: 'exhausted' }
  independentVerificationFollowup(): Record<string, unknown> | null
  honestyFollowup(): Message | null
  runStopHook(input: {
    sessionId: string
    cwd: string
    lastAssistantMessage: string
    stopHookActive: boolean
  }): Promise<TurnFinalizerStopDecision>
  appendHistory(message: Message): void
  persistStopContinuation(message: string): void
  emitPlanFollowup(detail: Record<string, unknown>): Promise<void>
  appendExecutionDisclosure(reply: string): string
  finalizeReplyChanges(reply: string): Promise<string>
  updateAssistantMessage(reply: string): void
  persistAssistant(reply: string): void
  compact(): Promise<void>
  completeIteration(): void
  emitCompleted(reply: string): Promise<void>
  markIndependentVerificationDelivered(): void
}

export type TurnFinalizerResult =
  | { readonly kind: 'continue' }
  | { readonly kind: 'completed'; readonly reply: string }

/** Owns the only successful assistant terminal path for a model turn. */
export class TurnFinalizer {
  private readonly sessionId: string
  private readonly cwd: string
  private readonly turnId: string | null
  private readonly ports: TurnFinalizerPorts
  private stopHookNudged = false

  constructor(input: {
    sessionId: string
    cwd: string
    turnId: string | null
    ports: TurnFinalizerPorts
  }) {
    this.sessionId = input.sessionId
    this.cwd = input.cwd
    this.turnId = input.turnId
    this.ports = input.ports
  }

  planSubmissionDecision():
    | { kind: 'none' }
    | { kind: 'followup'; attempt: number }
    | { kind: 'exhausted' } {
    return this.ports.planSubmissionDecision()
  }

  async finalize(draftReply: string): Promise<TurnFinalizerResult> {
    const verification = this.ports.independentVerificationFollowup()
    if (verification !== null) {
      this.ports.appendHistory({
        role: 'user',
        content: String(verification.message ?? ''),
      })
      await this.ports.emitPlanFollowup({
        plan_id: verification.plan_id,
        verification: verification.status,
      })
      return { kind: 'continue' }
    }

    const honesty = this.ports.honestyFollowup()
    if (honesty !== null) {
      this.ports.appendHistory(honesty)
      await this.ports.emitPlanFollowup({
        honesty: 'verification_unrecorded',
      })
      return { kind: 'continue' }
    }

    const stopDecision = await this.ports.runStopHook({
      sessionId: this.sessionId,
      cwd: this.cwd,
      lastAssistantMessage: draftReply,
      stopHookActive: this.stopHookNudged,
    })
    if (
      (stopDecision.continue === true ||
        stopDecision.decision === 'deny' ||
        stopDecision.decision === 'ask') &&
      !this.stopHookNudged
    ) {
      this.stopHookNudged = true
      const continuation = `[Stop hook] ${
        stopDecision.stopReason ||
        stopDecision.reason ||
        'Continue until the stop hook passes.'
      }`
      this.ports.appendHistory({
        role: 'user',
        content: continuation,
        ui_hidden: true,
        ...(this.turnId ? { turn_id: this.turnId } : {}),
      })
      this.ports.persistStopContinuation(continuation)
      await this.ports.emitPlanFollowup({
        hook: 'Stop',
        decision: stopDecision.decision,
      })
      return { kind: 'continue' }
    }

    let finalReply = this.ports.appendExecutionDisclosure(draftReply)
    finalReply = await this.ports.finalizeReplyChanges(finalReply)
    this.ports.updateAssistantMessage(finalReply)
    this.ports.persistAssistant(finalReply)
    await this.ports.compact()
    this.ports.completeIteration()
    await this.ports.emitCompleted(finalReply)
    this.ports.markIndependentVerificationDelivered()
    return { kind: 'completed', reply: finalReply }
  }
}
