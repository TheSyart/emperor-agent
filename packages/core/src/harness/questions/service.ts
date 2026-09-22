/**
 * User-questions service (ported from dsh-user-questions).
 *
 * Pauses an agent tool call until the human answers one or more questions.
 * The answerer is host-provided (the desktop UI), like
 * {@link ApprovalService}. Every ask is audited on the session log as a
 * `question/asked` + `question/answered` pair inside the open turn. Aborting
 * the call settles it `cancelled`; a missing or throwing answerer settles it
 * `unavailable`. Delegated (owned) child agents have no human answerer and
 * are refused outright.
 */

import { randomUUID } from 'node:crypto'
import { HarnessError } from '../../llm/error'
import type { RepairContributor } from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'

/** One selectable answer offered to the user. */
export interface UserQuestionOption {
  label: string
  description?: string
}

/** One question in a request. */
export interface UserQuestionItem {
  /** Stable caller-provided id, echoed in the answer. */
  id: string
  question: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional supporting detail (e.g. the plan markdown of a plan review). */
  detail?: string
  options?: UserQuestionOption[]
  /** Whether more than one option may be selected (default single-select). */
  multiSelect?: boolean
}

/**
 * A caller-declared presentation intent. It changes presentation only, never
 * the answer encoding: `approve` names the option label that approves.
 */
export interface UserQuestionIntent {
  kind: 'plan-review'
  approve: string
}

export interface UserAnswerItem {
  selected: string[]
  custom?: string
}

/** Answers keyed by question id. */
export type UserAnswers = Record<string, UserAnswerItem>

export type UserQuestionOutcome =
  | { outcome: 'answered'; answers: UserAnswers }
  | { outcome: 'cancelled' | 'unavailable' }

export interface UserQuestionRequest {
  readonly agent: Agent
  readonly callId?: string
  readonly questions: readonly UserQuestionItem[]
  readonly intent?: UserQuestionIntent
  readonly signal?: AbortSignal
}

/** Host-side answerer (UI). Receives the audit id so it can key the pending question. */
export type UserQuestionAnswerer = (
  request: UserQuestionRequest & { id: string },
) => Promise<UserAnswers>

declare module '../../session-log/types' {
  interface SessionEventMap {
    'question/asked': {
      id: string
      callId?: string
      questions: UserQuestionItem[]
      intent?: UserQuestionIntent
    }
    'question/answered':
      | { id: string; answers: UserAnswers }
      | { id: string; outcome: 'cancelled' | 'unavailable' }
  }
}

export class UserQuestionError extends HarnessError {}

/** Thrown by an answerer when the user dismissed the question (outcome `cancelled`). */
export class UserQuestionDismissed extends Error {
  override name = 'UserQuestionDismissed'
}

export const DELEGATED_CALLER_MESSAGE =
  'human interaction is unavailable while the calling agent is owned by another live agent; ' +
  "include the unresolved question or decision in the child agent's final result"

/** Crash repair: an ask without an answer is closed as `unavailable`. */
export const questionRepair: RepairContributor = (events) => {
  const open = new Map<string, true>()
  for (const event of events) {
    if (event.type === 'question/asked') open.set(event.data.id, true)
    else if (event.type === 'question/answered') open.delete(event.data.id)
  }
  return [...open.keys()].map(
    (id) =>
      ({
        type: 'question/answered',
        data: { id, outcome: 'unavailable' },
      }) as Omit<SessionEvent, 'seq' | 'time'>,
  )
}

function copyQuestion(question: UserQuestionItem): UserQuestionItem {
  return {
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.options === undefined
      ? {}
      : {
          options: question.options.map((o) => ({
            label: o.label,
            ...(o.description === undefined
              ? {}
              : { description: o.description }),
          })),
        }),
    ...(question.multiSelect === undefined
      ? {}
      : { multiSelect: question.multiSelect }),
  }
}

/** Keep only well-formed answers to asked questions; `undefined` when the reply is not an answer map. */
function sanitizeAnswers(
  raw: unknown,
  questions: readonly UserQuestionItem[],
): UserAnswers | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return undefined
  const record = raw as Record<string, unknown>
  const answers: UserAnswers = {}
  for (const question of questions) {
    if (!Object.hasOwn(record, question.id)) continue
    const item = record[question.id]
    if (typeof item !== 'object' || item === null) continue
    const { selected, custom } = item as {
      selected?: unknown
      custom?: unknown
    }
    const labels = Array.isArray(selected)
      ? selected.filter((s): s is string => typeof s === 'string')
      : []
    answers[question.id] = {
      selected: labels,
      ...(typeof custom === 'string' ? { custom } : {}),
    }
  }
  return answers
}

export class UserQuestionService {
  private answerer: UserQuestionAnswerer | undefined

  setAnswerer(answerer: UserQuestionAnswerer | undefined): void {
    this.answerer = answerer
  }

  get hasAnswerer(): boolean {
    return this.answerer !== undefined
  }

  /**
   * Ask the user and wait. Throws {@link UserQuestionError} (before logging)
   * for requests that can never be answered: empty questions, a malformed
   * intent, or a delegated caller (`DELEGATED_CALLER`).
   */
  async ask(request: UserQuestionRequest): Promise<UserQuestionOutcome> {
    if (request.questions.length === 0) {
      throw new UserQuestionError(
        'ask_user_question requires at least one question',
        'EMPTY_QUESTIONS',
      )
    }
    if (request.agent.owner !== undefined) {
      throw new UserQuestionError(DELEGATED_CALLER_MESSAGE, 'DELEGATED_CALLER')
    }
    const intent = request.intent
    if (intent !== undefined) {
      const target = request.questions.find((q) =>
        (q.options ?? []).some((option) => option.label === intent.approve),
      )
      if (target === undefined) {
        throw new UserQuestionError(
          `intent ${intent.kind} approve label ${JSON.stringify(intent.approve)} names none of the question options`,
          'BAD_INTENT',
        )
      }
      if (target.detail === undefined) {
        throw new UserQuestionError(
          `question ${target.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT',
        )
      }
    }
    const session = request.agent.session
    if (!session.hasOpenTurn())
      throw new Error('userQuestions.ask() outside an open turn')
    const id = randomUUID()
    const questions = request.questions.map(copyQuestion)
    session.append('question/asked', {
      id,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      questions,
      ...(intent === undefined
        ? {}
        : { intent: { kind: intent.kind, approve: intent.approve } }),
    })
    const outcome = await this.collect(request, questions, id)
    session.append(
      'question/answered',
      outcome.outcome === 'answered'
        ? { id, answers: outcome.answers }
        : { id, outcome: outcome.outcome },
    )
    return outcome
  }

  private async collect(
    request: UserQuestionRequest,
    questions: UserQuestionItem[],
    id: string,
  ): Promise<UserQuestionOutcome> {
    const signal = request.signal
    if (signal?.aborted) return { outcome: 'cancelled' }
    const answerer = this.answerer
    if (answerer === undefined) return { outcome: 'unavailable' }
    const answer: Promise<UserQuestionOutcome> = Promise.resolve()
      .then(() => answerer({ ...request, questions, id }))
      .then(
        (raw) => {
          const answers = sanitizeAnswers(raw, questions)
          return answers === undefined
            ? { outcome: 'unavailable' as const }
            : { outcome: 'answered' as const, answers }
        },
        (error: unknown) =>
          error instanceof UserQuestionDismissed
            ? { outcome: 'cancelled' as const }
            : { outcome: 'unavailable' as const },
      )
    if (signal === undefined) return answer
    return new Promise<UserQuestionOutcome>((resolve) => {
      const onAbort = (): void => {
        resolve({ outcome: 'cancelled' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      })
    })
  }
}
