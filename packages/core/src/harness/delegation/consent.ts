/**
 * First-dispatch consent for external executors (AGT-05, SUB-8).
 *
 * Handing a task to Claude Code or Codex spends the user's own subscription
 * quota or API billing, so the first dispatch to each executor asks in the
 * conversation: 本次允许 (the rest of this turn), 以后都允许 (remembered for
 * the executor until it is turned off in settings) or 不允许 (the task runs as
 * a local subagent instead). The card is an ordinary pending question whose
 * projection is an approval card (projection/interactions.ts).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../agent/agent'
import type { PendingInteractions } from '../host/interactions'
import { currentTurnInfo } from '../host/turn-source'
import { assertNotNewerSync, durableReplaceSync } from '../../store/persistence'
import type { UserAnswers, UserQuestionItem } from '../questions/service'
import type { DelegationOwner, ExecutorProfile } from './types'

export const CONSENT_QUESTION_ID = 'executor-consent'
export const CONSENT_ONCE = '本次允许'
export const CONSENT_ALWAYS = '以后都允许'
export const CONSENT_DENY = '不允许'

/** "以后都允许" per executor profile, in the delegations root. */
export class ExecutorConsentStore {
  readonly file: string
  constructor(readonly root: string) {
    this.file = join(root, 'consent.json')
  }
  private read(): Record<string, { grantedAt: number }> {
    try {
      if (!existsSync(this.file)) return {}
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as {
        schemaVersion?: unknown
        profiles?: unknown
      }
      if (
        value.schemaVersion !== 1 ||
        !value.profiles ||
        typeof value.profiles !== 'object'
      )
        return {}
      return value.profiles as Record<string, { grantedAt: number }>
    } catch {
      // Unreadable means not granted: the user is asked again.
      return {}
    }
  }
  private write(profiles: Record<string, { grantedAt: number }>): void {
    // A newer Emperor's consent.json stays as it is (REL-03): ask again.
    try {
      assertNotNewerSync(this.file, 'schemaVersion', 1)
    } catch {
      return
    }
    durableReplaceSync(
      this.file,
      JSON.stringify({ schemaVersion: 1, profiles }, null, 2) + '\n',
    )
  }
  granted(profileId: string): boolean {
    return Object.hasOwn(this.read(), profileId)
  }
  grant(profileId: string): void {
    this.write({ ...this.read(), [profileId]: { grantedAt: Date.now() } })
  }
  revoke(profileId: string): void {
    const profiles = this.read()
    if (!Object.hasOwn(profiles, profileId)) return
    delete profiles[profileId]
    this.write(profiles)
  }
}

export interface ConsentRequest {
  owner: DelegationOwner
  profile: ExecutorProfile
  /** The task's display name. */
  description: string
  callId?: string
  signal?: AbortSignal
}

const executorName = (backend: string) =>
  backend === 'codex' ? 'Codex' : 'Claude Code'

/** The card's question: what is handed over and who pays for it. */
export function consentQuestion(profile: ExecutorProfile): string {
  const name = executorName(profile.backend)
  const billing =
    profile.authRef.kind === 'model-route'
      ? '会使用你在 Emperor 中选择的模型凭据（按 API 计费）'
      : profile.backend === 'codex'
        ? '会使用你的 ChatGPT 额度（或 API Key 计费）'
        : '会使用你的 Claude 订阅额度（或 API Key 计费）'
  return `Emperor 想把这个子任务交给 ${name}，${billing}`
}

type Answer = 'once' | 'always' | 'deny'

export class ExecutorConsentBridge {
  /** Composed by CoreApi with the delegations root. */
  store: ExecutorConsentStore | undefined
  /** Decisions and open cards for one root turn and executor. */
  private readonly turns = new Map<string, Promise<Answer | undefined>>()
  constructor(
    private readonly options: {
      pending: PendingInteractions
      root: (id: string) => Agent | undefined
      /** A window can show the card (and the turn is not a scheduler's). */
      available: (owner: DelegationOwner) => boolean
      timeoutMs: () => number
    },
  ) {}

  /** True when the task may go to the external executor. */
  async decide(request: ConsentRequest): Promise<boolean> {
    // The user started it themselves: that is the consent.
    if (request.owner.source === 'human') return true
    if (this.store?.granted(request.profile.id)) return true
    const root = this.options.root(request.owner.rootSessionId)
    if (
      !root ||
      root.owner ||
      request.owner.source === 'scheduler' ||
      !this.options.available(request.owner)
    )
      return false
    const turn = currentTurnInfo(root.session.events).turn
    const key = JSON.stringify([root.id, request.profile.id, turn ?? null])
    let decision = this.turns.get(key)
    if (!decision) {
      decision = this.ask(root, request)
      this.turns.set(key, decision)
      // Dismissed, expired or cancelled cards are not remembered.
      void decision.then((answer) => {
        if (answer === undefined) this.turns.delete(key)
      })
    }
    const answer = await decision
    if (answer === 'always') this.store?.grant(request.profile.id)
    return answer === 'once' || answer === 'always'
  }

  private async ask(
    root: Agent,
    request: ConsentRequest,
  ): Promise<Answer | undefined> {
    if (request.signal?.aborted) return undefined
    const id =
      'consent-' +
      createHash('sha256')
        .update(
          JSON.stringify([
            root.id,
            request.profile.id,
            request.callId ?? null,
            Date.now(),
            Math.random(),
          ]),
        )
        .digest('hex')
        .slice(0, 24)
    const text = consentQuestion(request.profile)
    const questions: UserQuestionItem[] = [
      {
        id: CONSENT_QUESTION_ID,
        header: '子智能体',
        question: text,
        detail: request.description,
        options: [
          { label: CONSENT_ONCE },
          { label: CONSENT_ALWAYS },
          { label: CONSENT_DENY },
        ],
      },
    ]
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, this.options.timeoutMs())
    timer.unref?.()
    const answered = this.options.pending.questionAnswerer({
      id,
      agent: root,
      questions,
      signal: controller.signal,
    })
    root.session.append('question/asked', {
      id,
      ...(request.callId ? { callId: request.callId } : {}),
      questions,
      consent: {
        backend: request.profile.backend,
        profileId: request.profile.id,
        description: request.description,
      },
    })
    let value: UserAnswers | undefined
    try {
      value = await answered
    } catch {
      value = undefined
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
      root.session.append(
        'question/answered',
        value ? { id, answers: value } : { id, outcome: 'cancelled' },
      )
    }
    const choice = value?.[CONSENT_QUESTION_ID]?.selected?.[0]
    return choice === CONSENT_ONCE
      ? 'once'
      : choice === CONSENT_ALWAYS
        ? 'always'
        : choice === CONSENT_DENY
          ? 'deny'
          : undefined
  }

  /** Stop and forget everything for a root (stop, close). */
  cancelRoot(rootSessionId?: string): void {
    for (const key of [...this.turns.keys()])
      if (
        rootSessionId === undefined ||
        (JSON.parse(key) as unknown[])[0] === rootSessionId
      )
        this.turns.delete(key)
  }
}
