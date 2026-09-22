/**
 * Approval service (ported from dsh-user-approval).
 *
 * Policy `ask` delegates to the answerer (the desktop UI), `never` rejects
 * deterministically. Every question is audited on the session log as an
 * `approval/asked` + `approval/decided` pair inside the open turn. The
 * question blocks the tool call until answered; aborting the call settles it
 * `cancelled`. A missing or throwing answerer fails closed (`unavailable`).
 */

import { randomUUID } from 'node:crypto'
import { contextMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import type { RepairContributor } from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import type { SystemPromptAssembler } from '../prompt/assembler'
import type { ApprovalOutcome } from '../tools/registry'

export type { ApprovalOutcome } from '../tools/registry'
export type ApprovalPolicy = 'ask' | 'never'
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['ask', 'never']
const OUTCOMES: readonly ApprovalOutcome[] = [
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
]

declare module '../../session-log/types' {
  interface SessionEventMap {
    'approval/asked': {
      id: string
      toolName: string
      callId?: string
      reason?: string
    }
    'approval/decided': { id: string; outcome: ApprovalOutcome }
    'approval/policy': { policy: ApprovalPolicy; source?: 'delegation' }
  }
}

const NEVER_SENTENCE =
  'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
const ASK_SENTENCE =
  'Approval policy: ask. Operations that require approval ask the user; without an available answerer, the request fails closed.'

export interface ApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** Host-side answerer (UI). Receives the audit id so it can key the pending question. */
export type ApprovalAnswerer = (
  request: ApprovalRequest & { id: string },
) => Promise<ApprovalOutcome>

export function effectiveApprovalPolicy(
  events: readonly SessionEvent[],
): ApprovalPolicy | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'approval/policy') return event.data.policy
  }
  return undefined
}

/** Crash repair: an ask without a decision is closed as `unavailable`. */
export const approvalRepair: RepairContributor = (events) => {
  const open = new Map<string, true>()
  for (const event of events) {
    if (event.type === 'approval/asked') open.set(event.data.id, true)
    else if (event.type === 'approval/decided') open.delete(event.data.id)
  }
  return [...open.keys()].map(
    (id) =>
      ({
        type: 'approval/decided',
        data: { id, outcome: 'unavailable' },
      }) as Omit<SessionEvent, 'seq' | 'time'>,
  )
}

export class ApprovalService {
  private answerer: ApprovalAnswerer | undefined

  constructor(private readonly defaultPolicy: ApprovalPolicy = 'ask') {}

  install(prompt: SystemPromptAssembler): () => void {
    return prompt.context({
      name: 'approval:policy',
      order: 115,
      text: ({ agent }) =>
        agent === undefined
          ? ''
          : this.effectivePolicy(agent.session) === 'never'
            ? NEVER_SENTENCE
            : ASK_SENTENCE,
    })
  }

  setAnswerer(answerer: ApprovalAnswerer | undefined): void {
    this.answerer = answerer
  }

  effectivePolicy(session: Session): ApprovalPolicy {
    return effectiveApprovalPolicy(session.events) ?? this.defaultPolicy
  }

  /** Record a policy switch on the log (no model notice). */
  record(
    session: Session,
    policy: ApprovalPolicy,
    source?: 'delegation',
  ): void {
    if (!APPROVAL_POLICIES.includes(policy))
      throw new TypeError('approval policy must be one of "ask" or "never"')
    session.append('approval/policy', {
      policy,
      ...(source === undefined ? {} : { source }),
    })
  }

  /** Switch a live agent's policy and tell the model at its next step. */
  setPolicy(agent: Agent, policy: ApprovalPolicy): void {
    const previous = this.effectivePolicy(agent.session)
    if (previous === policy) return
    this.record(agent.session, policy)
    agent.inject(
      contextMessage(
        'approval',
        `The approval policy changed from "${previous}" to "${policy}" (changed by the user).`,
        { form: 'notice', summary: `approval policy: ${policy}` },
      ),
    )
  }

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = request.agent.session
    if (!session.hasOpenTurn())
      throw new Error('approval.request() outside an open turn')
    const id = randomUUID()
    session.append('approval/asked', {
      id,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    const outcome = await this.decide(request, session, id)
    session.append('approval/decided', { id, outcome })
    return outcome
  }

  private async decide(
    request: ApprovalRequest,
    session: Session,
    id: string,
  ): Promise<ApprovalOutcome> {
    const signal = request.signal
    if (signal?.aborted) return 'cancelled'
    if (this.effectivePolicy(session) === 'never') return 'rejected'
    const answerer = this.answerer
    if (answerer === undefined) return 'unavailable'
    const answer: Promise<ApprovalOutcome> = Promise.resolve()
      .then(() => answerer({ ...request, id }))
      .then(
        (outcome) => (OUTCOMES.includes(outcome) ? outcome : 'unavailable'),
        () => 'unavailable' as const,
      )
    if (signal === undefined) return answer
    return new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = (): void => {
        resolve('cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      })
    })
  }
}
