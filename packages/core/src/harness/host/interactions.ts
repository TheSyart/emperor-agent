/**
 * Pending interactions: the host-side answerer for approvals and user
 * questions. A question blocks inside its tool call until the UI answers
 * through `control.*`; the answer resolves the waiting promise directly (no
 * turn pause, no resume-as-new-turn).
 *
 * Interaction ids on the wire: `approval_<id>`, `ask_<id>`, `plan_<id>`.
 */

import type { ApprovalAnswerer, ApprovalOutcome } from '../approval/service'
import {
  PERMISSION_ALLOW,
  PERMISSION_DENY,
  PERMISSION_QUESTION_ID,
  PLAN_APPROVE_LABEL,
  PLAN_KEEP_LABEL,
} from '../projection/interactions'
import {
  UserQuestionDismissed,
  type UserAnswers,
  type UserQuestionAnswerer,
  type UserQuestionItem,
} from '../questions/service'

export class InteractionNotPendingError extends Error {
  readonly code = 'interaction_not_pending'
  constructor(id: string) {
    super(`interaction "${id}" is not pending`)
    this.name = 'InteractionNotPendingError'
  }
}

interface PendingApproval {
  kind: 'approval'
  id: string
  sessionId: string
  resolve(outcome: ApprovalOutcome): void
}

interface PendingQuestion {
  kind: 'question' | 'plan'
  id: string
  sessionId: string
  questions: readonly UserQuestionItem[]
  resolve(answers: UserAnswers): void
  reject(error: Error): void
}

type Pending = PendingApproval | PendingQuestion

/** UI answer shape: `{ [questionId]: { option_id?, choice, freeform } }` (legacy `answers` arrays also accepted). */
export type UiAnswers = Record<string, unknown>

function uiAnswer(value: unknown): {
  optionId?: string
  choice: string
  freeform: string
} {
  if (typeof value === 'string') return { choice: value, freeform: '' }
  if (typeof value !== 'object' || value === null)
    return { choice: '', freeform: '' }
  const record = value as Record<string, unknown>
  const selected = Array.isArray(record.selected)
    ? record.selected.map(String)
    : undefined
  return {
    ...(typeof record.option_id === 'string'
      ? { optionId: record.option_id }
      : {}),
    choice:
      selected !== undefined
        ? selected.join('\u0000')
        : String(record.choice ?? ''),
    freeform: String(record.freeform ?? record.custom ?? ''),
  }
}

export class PendingInteractions {
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(sessionId: string) => void>()

  /** Notified whenever a session's pending set changes (for control_mode_update). */
  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId)
      } catch {
        // ignore
      }
    }
  }

  forSession(sessionId: string): string[] {
    return [...this.pending.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => this.wireId(entry))
  }

  hasPending(sessionId: string): boolean {
    return [...this.pending.values()].some(
      (entry) => entry.sessionId === sessionId,
    )
  }

  private wireId(entry: Pending): string {
    return entry.kind === 'approval'
      ? `approval_${entry.id}`
      : entry.kind === 'plan'
        ? `plan_${entry.id}`
        : `ask_${entry.id}`
  }

  private take(wireId: string): Pending {
    const entry = this.pending.get(wireId)
    if (entry === undefined) throw new InteractionNotPendingError(wireId)
    this.pending.delete(wireId)
    this.changed(entry.sessionId)
    return entry
  }

  readonly approvalAnswerer: ApprovalAnswerer = (request) =>
    new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingApproval = {
        kind: 'approval',
        id: request.id,
        sessionId: request.agent.id,
        resolve,
      }
      const wireId = this.wireId(entry)
      this.pending.set(wireId, entry)
      request.signal?.addEventListener(
        'abort',
        () => {
          if (this.pending.get(wireId) === entry) {
            this.pending.delete(wireId)
            this.changed(entry.sessionId)
          }
        },
        { once: true },
      )
      this.changed(entry.sessionId)
    })

  readonly questionAnswerer: UserQuestionAnswerer = (request) =>
    new Promise<UserAnswers>((resolve, reject) => {
      const entry: PendingQuestion = {
        kind: request.intent?.kind === 'plan-review' ? 'plan' : 'question',
        id: request.id,
        sessionId: request.agent.id,
        questions: request.questions,
        resolve,
        reject,
      }
      const wireId = this.wireId(entry)
      this.pending.set(wireId, entry)
      request.signal?.addEventListener(
        'abort',
        () => {
          if (this.pending.get(wireId) === entry) {
            this.pending.delete(wireId)
            this.changed(entry.sessionId)
          }
        },
        { once: true },
      )
      this.changed(entry.sessionId)
    })

  /** Session that owns a pending interaction, if pending. */
  sessionOf(wireId: string): string | undefined {
    return this.pending.get(wireId)?.sessionId
  }

  /** Answer an approval or a question from UI answers. */
  answer(wireId: string, answers: UiAnswers): void {
    const entry = this.pending.get(wireId)
    if (entry === undefined) throw new InteractionNotPendingError(wireId)
    if (entry.kind === 'approval') {
      const answer = uiAnswer(
        answers[PERMISSION_QUESTION_ID] ?? Object.values(answers)[0],
      )
      const allowed =
        answer.optionId === PERMISSION_ALLOW ||
        (answer.optionId === undefined && /允许|allow/i.test(answer.choice))
      this.take(wireId)
      entry.resolve(
        allowed && answer.optionId !== PERMISSION_DENY
          ? 'allowed-once'
          : 'rejected',
      )
      return
    }
    if (entry.kind === 'plan') {
      const review =
        answers[entry.questions[0]?.id ?? ''] ?? Object.values(answers)[0]
      const answer = uiAnswer(review)
      this.take(wireId)
      entry.resolve({
        [entry.questions[0]?.id ?? 'plan-review']:
          answer.choice === PLAN_APPROVE_LABEL && answer.freeform === ''
            ? { selected: [PLAN_APPROVE_LABEL] }
            : {
                selected: [PLAN_KEEP_LABEL],
                ...(answer.freeform === '' ? {} : { custom: answer.freeform }),
              },
      })
      return
    }
    const out: UserAnswers = {}
    for (const question of entry.questions) {
      const answer = uiAnswer(answers[question.id])
      const selected =
        answer.choice === ''
          ? []
          : answer.choice
              .split('\u0000')
              .flatMap((part) => part.split(/\s*,\s*/))
              .filter(Boolean)
      const labels = new Set(
        (question.options ?? []).map((option) => option.label),
      )
      const picked = selected.filter((label) => labels.has(label))
      const unmatched = selected.filter((label) => !labels.has(label))
      const custom = [answer.freeform, ...unmatched].filter(Boolean).join(' · ')
      out[question.id] = {
        selected: picked,
        ...(custom === '' ? {} : { custom }),
      }
    }
    this.take(wireId)
    entry.resolve(out)
  }

  approvePlan(wireId: string): void {
    const entry = this.pending.get(wireId)
    if (entry?.kind !== 'plan') throw new InteractionNotPendingError(wireId)
    this.take(wireId)
    entry.resolve({
      [entry.questions[0]?.id ?? 'plan-review']: {
        selected: [PLAN_APPROVE_LABEL],
      },
    })
  }

  commentPlan(wireId: string, comment: string): void {
    const entry = this.pending.get(wireId)
    if (entry?.kind !== 'plan') throw new InteractionNotPendingError(wireId)
    this.take(wireId)
    const custom = comment.trim()
    entry.resolve({
      [entry.questions[0]?.id ?? 'plan-review']: {
        selected: [PLAN_KEEP_LABEL],
        ...(custom === '' ? {} : { custom }),
      },
    })
  }

  cancel(wireId: string): void {
    const entry = this.take(wireId)
    if (entry.kind === 'approval') entry.resolve('cancelled')
    else
      entry.reject(new UserQuestionDismissed('the user dismissed the question'))
  }

  /** Cancel every pending interaction of a session (session end / stop). */
  cancelSession(sessionId: string): void {
    for (const [wireId, entry] of [...this.pending]) {
      if (entry.sessionId === sessionId) this.cancel(wireId)
    }
  }
}
