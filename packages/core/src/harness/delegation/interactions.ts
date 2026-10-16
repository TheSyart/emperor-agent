import { createHash } from 'node:crypto'
import type { Agent } from '../agent/agent'
import type { PendingInteractions } from '../host/interactions'
import type { UserAnswers } from '../questions/service'
import {
  DelegationError,
  type DelegationOwner,
  type ExecutorQuestion,
} from './types'
export interface DelegationQuestion {
  owner: DelegationOwner
  delegationId: string
  runId: string
  generation: number
  requestId: string
  backend: string
  questions: ExecutorQuestion[]
}
export type DelegationQuestionOutcome =
  | { outcome: 'answered'; answers: Record<string, string> }
  | { outcome: 'cancelled' | 'expired' | 'unavailable' }
export class DelegationInteractionBridge {
  private readonly live = new Map<
    string,
    { runId: string; rootSessionId: string; controller: AbortController }
  >()
  constructor(
    private readonly options: {
      pending: PendingInteractions
      root: (id: string) => Agent | undefined
      available: (owner: DelegationOwner) => boolean
      timeoutMs: () => number
    },
  ) {}
  async ask(
    question: DelegationQuestion,
    signal: AbortSignal,
  ): Promise<DelegationQuestionOutcome> {
    if (signal.aborted) return { outcome: 'cancelled' }
    const root = this.options.root(question.owner.rootSessionId)
    if (
      !root ||
      root.owner ||
      question.owner.source === 'scheduler' ||
      !this.options.available(question.owner)
    )
      return { outcome: 'unavailable' }
    if (
      !question.questions.length ||
      question.questions.some((q) => !q.id || !q.title)
    )
      throw new DelegationError(
        'INVALID_QUESTION',
        'business question requires an identity and title',
      )
    const id =
      'external-' +
      createHash('sha256')
        .update(
          JSON.stringify([
            question.delegationId,
            question.runId,
            question.generation,
            question.requestId,
          ]),
        )
        .digest('hex')
    if (this.live.has(id))
      throw new DelegationError(
        'DUPLICATE_REQUEST',
        'external question is already displayed',
      )
    const controller = new AbortController()
    this.live.set(id, {
      runId: question.runId,
      rootSessionId: question.owner.rootSessionId,
      controller,
    })
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, this.options.timeoutMs())
    timer.unref?.()
    const questions = question.questions.map((q) => ({
      id: q.id,
      header: question.backend,
      question: q.title,
      detail: `Delegation ${question.delegationId}, run ${question.runId}. This is a business answer; it grants no permissions.`,
      ...(q.options?.length
        ? { options: q.options.map((label) => ({ label })) }
        : {}),
    }))
    const answered = this.options.pending.questionAnswerer({
      id,
      agent: root,
      questions,
      signal: controller.signal,
    })
    root.session.append('question/asked', {
      id,
      questions,
      external: {
        delegationId: question.delegationId,
        runId: question.runId,
        generation: question.generation,
        requestId: question.requestId,
        backend: question.backend,
      },
    })
    let finishAbort!: () => void
    const cancelled = new Promise<undefined>((resolve) => {
      finishAbort = () => resolve(undefined)
      controller.signal.addEventListener('abort', finishAbort, { once: true })
      if (controller.signal.aborted) finishAbort()
    })
    let audit: UserAnswers | undefined
    try {
      const value = await Promise.race([
        answered.catch(() => undefined),
        cancelled,
      ])
      if (controller.signal.aborted)
        return { outcome: expired ? 'expired' : 'cancelled' }
      if (!value) return { outcome: 'cancelled' }
      const answers: Record<string, string> = {}
      for (const q of question.questions) {
        const a = value[q.id],
          text = [...(a?.selected ?? []), a?.custom ?? '']
            .filter(Boolean)
            .join(', ')
        if (!text.trim() || Buffer.byteLength(text) > 4096)
          return { outcome: 'unavailable' }
        answers[q.id] = text
      }
      audit = value
      return { outcome: 'answered', answers }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', finishAbort)
      controller.abort()
      this.live.delete(id)
      root.session.append(
        'question/answered',
        audit
          ? { id, answers: audit }
          : { id, outcome: expired ? 'unavailable' : 'cancelled' },
      )
    }
  }
  cancelRoot(rootSessionId?: string): void {
    for (const item of this.live.values())
      if (rootSessionId === undefined || item.rootSessionId === rootSessionId)
        item.controller.abort()
  }
  cancelRun(runId: string): void {
    for (const item of this.live.values())
      if (item.runId === runId) item.controller.abort()
  }
}
