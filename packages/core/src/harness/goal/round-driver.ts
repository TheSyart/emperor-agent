/**
 * Same-session goal-round driver (ported from dsh-goal-round-driver).
 *
 * When an attached agent goes idle with an `active` + `armed` goal that has
 * round capacity, the driver durably reserves round `roundsStarted + 1`
 * (`goal/round`) and queues one `<goal_round>` context message with
 * `agent.followup()`. Its pre-step gate admits the message only while the
 * reservation still names the exact live revision; only the matching
 * `user/message` entering a step consumes a round. At the cap the goal is
 * blocked with `round-limit`.
 *
 * Idle checkpoint outcomes (dsh semantics):
 * - admitted round finished normally → reserve the next round;
 * - reserved/claimed round never admitted, or admitted round cancelled
 *   (turn aborted) → durable `pause` (fallback: disarm);
 * - downstream pre-step rejection of a valid round → `block` `prompt-rejected`;
 * - cancellation unrelated to a goal round, max-tokens, or agent error → disarm.
 *
 * Human work always wins: a competing `next-turn` message queued while a
 * reservation is still pending makes it stale; the round is re-reserved at
 * the next idle checkpoint.
 */

import { contextMessage, type UserMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import { logger } from '../../util/log'
import type { Agent } from '../agent/agent'
import type {
  PreStepDecision,
  PreStepInput,
  PreStepMiddleware,
} from '../agent/middleware'
import { RUNTIME_CONTEXT_PRODUCER } from '../agent/runtime-context'
import { isNextRound } from './fold'
import { renderGoalRoundPrompt } from './prompt'
import type { GoalService } from './service'
import type { GoalRef, GoalView } from './types'

/** Context producer of `<goal_round>` messages. */
export const GOAL_ROUND_PRODUCER = 'goal'

interface RoundAttempt {
  readonly goalId: string
  readonly revision: number
  readonly round: number
  readonly messageId: string
  phase: 'queued' | 'claimed' | 'admitted'
  cancelled: boolean
  stale: boolean
  /** A downstream pre-step middleware rejected the (valid) round. */
  rejected: boolean
}

interface DriverState {
  readonly agent: Agent
  attempt: RoundAttempt | undefined
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  running: boolean
  stopping: boolean
  /** The gate rejected a whole step; pending inbox work needs a fresh wakeup. */
  rewake: boolean
  readonly disposers: Array<() => void>
}

export interface GoalRoundDriverOptions {
  /** Durability checkpoint awaited after a goal change, before queuing work (e.g. the session store flush). */
  flush?: (session: Session) => Promise<void>
}

/** Whether a message is a `<goal_round>` continuation prompt. */
export function isGoalRoundMessage(message: UserMessage): boolean {
  return (
    message.source.kind === 'context' &&
    message.source.producer === GOAL_ROUND_PRODUCER
  )
}

function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isRuntimeContext(message: UserMessage): boolean {
  return (
    message.source.kind === 'context' &&
    message.source.producer === RUNTIME_CONTEXT_PRODUCER
  )
}

export class GoalRoundDriver {
  private readonly states = new Map<Agent, DriverState>()

  /** Pre-step gate; {@link installGoal} pushes it onto `middleware.preStep`. */
  readonly preStep: PreStepMiddleware = (input) => this.gate(input)

  constructor(
    private readonly service: GoalService,
    private readonly options: GoalRoundDriverOptions = {},
  ) {}

  /** Whether an agent is currently attached. */
  attached(agent: Agent): boolean {
    return this.states.has(agent)
  }

  /**
   * Drive goal rounds for one agent. Attaching never inherits activation:
   * an armed goal is disarmed until an explicit resume. The disposer
   * disarms, withdraws or cancels an in-flight round, and detaches.
   */
  attach(agent: Agent): () => void {
    if (this.states.has(agent))
      throw new Error(
        `goal round driver is already attached to agent "${agent.id}"`,
      )
    const state: DriverState = {
      agent,
      attempt: undefined,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      running: false,
      stopping: false,
      rewake: false,
      disposers: [],
    }
    this.states.set(agent, state)
    this.disarm(state)
    state.disposers.push(
      agent.observe({
        status: (_agent, status) => {
          if (status === 'idle') this.onIdle(state)
        },
        error: () => {
          this.disarm(state)
        },
      }),
    )
    state.disposers.push(
      agent.session.subscribe((_session, event) => {
        this.onEvent(state, event)
      }),
    )
    state.disposers.push(
      this.service.onChange(({ agent: subject }) => {
        if (subject.session !== agent.session) return
        state.needsCheckpoint = true
        this.requestDrive(state)
      }),
    )
    return () => {
      this.detach(state)
    }
  }

  private detach(state: DriverState): void {
    if (this.states.get(state.agent) !== state) return
    state.stopping = true
    this.disarm(state)
    for (const dispose of state.disposers.splice(0)) dispose()
    const attempt = state.attempt
    state.attempt = undefined
    if (attempt !== undefined) {
      attempt.stale = true
      if (
        attempt.phase === 'queued' &&
        state.agent.inbox.remove(attempt.messageId)
      ) {
        // withdrawn before any step claimed it
      } else if (state.agent.status === 'running') {
        state.agent.cancel({ kind: 'parent' })
      }
    }
    this.states.delete(state.agent)
  }

  private currentGoal(state: DriverState): GoalView | undefined {
    return this.service.get(state.agent)
  }

  private disarm(state: DriverState): void {
    try {
      if (this.currentGoal(state)?.activation === 'armed')
        this.service.disarm(state.agent)
    } catch (error: unknown) {
      logger.warn('goal-round-driver: could not disarm', {
        session: state.agent.id,
        error: renderThrown(error),
      })
    }
  }

  private isArmedActive(
    goal: GoalView | undefined,
    attempt?: Pick<RoundAttempt, 'goalId' | 'revision'>,
  ): goal is GoalView {
    return (
      goal !== undefined &&
      goal.phase === 'active' &&
      goal.activation === 'armed' &&
      (attempt === undefined ||
        (goal.id === attempt.goalId && goal.revision === attempt.revision))
    )
  }

  private stillQueued(state: DriverState, attempt: RoundAttempt): boolean {
    return (
      attempt.phase === 'queued' &&
      state.agent.inbox.locate(attempt.messageId) !== undefined
    )
  }

  private onEvent(state: DriverState, event: SessionEvent): void {
    const attempt = state.attempt
    switch (event.type) {
      case 'agent/inbox/spliced':
        if (event.data.target !== 'next-turn') return
        for (const message of event.data.inserted) {
          if (attempt !== undefined && message.id === attempt.messageId)
            continue
          state.competingQueued = true
          if (attempt?.phase === 'queued') attempt.stale = true
        }
        return
      case 'user/message':
        if (attempt !== undefined && event.data.id === attempt.messageId)
          attempt.phase = 'admitted'
        return
      case 'turn/end': {
        const reason = event.data.reason
        if (reason.kind === 'max-tokens') {
          this.disarm(state)
        } else if (reason.kind === 'aborted') {
          // Claimed/admitted (or discarded from the inbox by the cancel) → the round was cancelled.
          if (attempt !== undefined && !this.stillQueued(state, attempt))
            attempt.cancelled = true
          else this.disarm(state)
        } else if (
          reason.kind === 'blocked' &&
          attempt !== undefined &&
          attempt.phase !== 'admitted' &&
          !this.stillQueued(state, attempt)
        ) {
          attempt.rejected = true
        }
        return
      }
      default:
    }
  }

  private onIdle(state: DriverState): void {
    if (state.stopping) return
    state.competingQueued = false
    const attempt = state.attempt
    if (
      attempt !== undefined &&
      !this.stillQueued(state, attempt) &&
      (attempt.rejected || attempt.cancelled || attempt.phase !== 'admitted')
    ) {
      const goal = this.currentGoal(state)
      if (this.isArmedActive(goal, attempt.rejected ? attempt : undefined)) {
        state.attempt = undefined
        try {
          if (attempt.rejected) {
            this.service.block(state.agent, goalRef(goal), {
              code: 'prompt-rejected',
              message: 'Goal round was rejected before entering its step.',
            })
          } else {
            this.service.pause(state.agent, goalRef(goal))
          }
        } catch (error: unknown) {
          logger.warn('goal-round-driver: could not stop the cancelled goal', {
            session: state.agent.id,
            error: renderThrown(error),
          })
          this.disarm(state)
        }
      }
    }
    this.requestDrive(state)
  }

  /** Coalesce triggers onto one agent-local serialized drive loop. */
  private requestDrive(state: DriverState): void {
    if (state.stopping) return
    state.requested = true
    if (state.running) return
    state.running = true
    queueMicrotask(() => {
      void (async () => {
        try {
          while (state.requested && !state.stopping) {
            state.requested = false
            try {
              await this.drive(state)
            } catch (error: unknown) {
              logger.warn('goal-round-driver: drive failed', {
                session: state.agent.id,
                error: renderThrown(error),
              })
              this.disarm(state)
            }
          }
        } finally {
          state.running = false
          if (state.requested && !state.stopping) this.requestDrive(state)
        }
      })()
    })
  }

  private ready(state: DriverState): boolean {
    return (
      !state.stopping &&
      this.states.get(state.agent) === state &&
      state.agent.status === 'idle' &&
      !state.competingQueued
    )
  }

  private async drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!this.ready(state)) return

    if (state.rewake) {
      // A rejected step ends the turn without draining the inbox; re-send
      // the first pending message (same identity) so queued work runs.
      state.rewake = false
      const pending = agent.inbox.nextTurn[0] ?? agent.inbox.nextStep[0]
      if (pending !== undefined) {
        const target = agent.inbox.locate(pending.id)?.target ?? 'next-turn'
        agent.inbox.remove(pending.id)
        agent.send(pending, target, true)
        state.requested = true
        return
      }
    }

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      if (this.options.flush !== undefined) {
        try {
          await this.options.flush(agent.session)
        } catch (error: unknown) {
          logger.warn('goal-round-driver: durability checkpoint failed', {
            session: agent.id,
            error: renderThrown(error),
          })
          this.disarm(state)
          return
        }
        // A mutation or ordinary prompt may have arrived meanwhile.
        if (!this.ready(state) || state.needsCheckpoint) {
          state.requested = true
          return
        }
      }
    }

    if (state.attempt !== undefined) {
      // Still waiting in the inbox (e.g. behind maintenance): not settled yet.
      if (this.stillQueued(state, state.attempt)) return
      // The previous round settled at this idle checkpoint.
      state.attempt = undefined
      state.needsCheckpoint = true
      state.requested = true
      return
    }

    const goal = this.currentGoal(state)
    if (!this.isArmedActive(goal)) return
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      this.service.block(agent, goalRef(goal), {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      })
      return
    }
    if (agent.inbox.hasPending) return

    const round = goal.roundsStarted + 1
    const message = contextMessage(
      GOAL_ROUND_PRODUCER,
      renderGoalRoundPrompt(goal, round),
    )
    agent.session.append('goal/round', {
      goalId: goal.id,
      revision: goal.revision,
      round,
      messageId: message.id,
    })
    state.attempt = {
      goalId: goal.id,
      revision: goal.revision,
      round,
      messageId: message.id,
      phase: 'queued',
      cancelled: false,
      stale: false,
      rejected: false,
    }
    try {
      agent.followup(message)
    } catch (error: unknown) {
      state.attempt = undefined
      logger.warn('goal-round-driver: could not queue a round', {
        session: agent.id,
        round,
        error: renderThrown(error),
      })
      const latest = this.currentGoal(state)
      if (
        this.isArmedActive(latest, { goalId: goal.id, revision: goal.revision })
      ) {
        this.service.block(agent, goalRef(latest), {
          code: 'queue-failed',
          message: `Could not queue goal round ${round}: ${renderThrown(error)}`,
        })
      }
    }
  }

  /** Admit only the exact reserved round of the exact live revision. */
  private gate({ agent, messages }: PreStepInput): PreStepDecision | undefined {
    const submitted = messages.find(isGoalRoundMessage)
    if (submitted === undefined) return undefined
    const state = this.states.get(agent)
    const attempt = state?.attempt
    const ours = attempt !== undefined && attempt.messageId === submitted.id
    if (ours) attempt.phase = 'claimed'
    let valid = false
    if (ours && state !== undefined && !state.stopping && !attempt.stale) {
      try {
        const goal = this.service.get(agent)
        valid =
          this.isArmedActive(goal, attempt) &&
          isNextRound({ goal, roundsStarted: goal.roundsStarted }, attempt)
      } catch (error: unknown) {
        logger.warn('goal-round-driver: pre-step check failed', {
          session: agent.id,
          error: renderThrown(error),
        })
        this.disarm(state)
      }
    }
    if (valid) return undefined
    if (ours && state !== undefined) {
      state.attempt = undefined
      this.requestDrive(state)
    }
    const remaining = messages.filter((message) => message.id !== submitted.id)
    if (remaining.some((message) => !isRuntimeContext(message)))
      return { kind: 'enter', messages: remaining }
    if (state !== undefined) {
      state.rewake = true
      this.requestDrive(state)
    }
    return { kind: 'reject' }
  }
}
