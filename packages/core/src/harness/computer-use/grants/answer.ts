/**
 * Parse the UI's answer to a grant card. Fail closed: anything that is not
 * exactly one of the offered scopes is a denial. The wire shape follows the
 * other interaction answers:
 *
 *   { grant: { option_id: 'once' | 'task' | 'session' | 'timed:15' | 'deny',
 *              background?: boolean } }
 */

import type { UiGrantScope } from '../types'
import type { GrantDecision } from '../events'

export const GRANT_QUESTION_ID = 'grant'
export const GRANT_DENY = 'deny'
/** Offered timed durations, in minutes. */
export const GRANT_TIMED_MINUTES = [15, 60] as const

export interface GrantAnswer {
  readonly decision: GrantDecision
  readonly minutes?: number
  readonly backgroundAllowed: boolean
  /** Why a non-denial was turned into a denial. */
  readonly invalid?: string
  /** The card was dismissed (session stop, emergency stop, abort). */
  readonly cancelled?: true
}

export interface GrantOption {
  readonly id: string
  readonly label: string
}

const SCOPE_LABELS: Record<Exclude<UiGrantScope, 'timed'>, string> = {
  once: '仅本次',
  task: '本任务',
  session: '本会话',
}

/** Card options for the scopes a request allows, deny last. */
export function grantOptions(allowed: readonly UiGrantScope[]): GrantOption[] {
  const options: GrantOption[] = []
  for (const scope of ['once', 'task', 'session'] as const)
    if (allowed.includes(scope))
      options.push({ id: scope, label: SCOPE_LABELS[scope] })
  if (allowed.includes('timed'))
    for (const minutes of GRANT_TIMED_MINUTES)
      options.push({
        id: `timed:${minutes}`,
        label: minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`,
      })
  options.push({ id: GRANT_DENY, label: '拒绝' })
  return options
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parseGrantAnswer(
  answers: Record<string, unknown>,
  allowed: readonly UiGrantScope[],
  backgroundOffered: boolean,
): GrantAnswer {
  const denied = (invalid?: string): GrantAnswer => ({
    decision: 'denied',
    backgroundAllowed: false,
    ...(invalid === undefined ? {} : { invalid }),
  })
  const answer = record(answers[GRANT_QUESTION_ID])
  if (answer === undefined) return denied('missing answer')
  const optionId = answer.option_id
  if (typeof optionId !== 'string') return denied('missing option id')
  if (optionId === GRANT_DENY) return denied()
  const background = backgroundOffered && answer.background === true
  const timed = /^timed:(\d{1,4})$/.exec(optionId)
  if (timed !== null) {
    const minutes = Number(timed[1])
    if (
      !allowed.includes('timed') ||
      !(GRANT_TIMED_MINUTES as readonly number[]).includes(minutes)
    )
      return denied(`option ${optionId} was not offered`)
    return { decision: 'timed', minutes, backgroundAllowed: background }
  }
  if (optionId === 'once' || optionId === 'task' || optionId === 'session') {
    if (!allowed.includes(optionId))
      return denied(`option ${optionId} was not offered`)
    return { decision: optionId, backgroundAllowed: background }
  }
  return denied(`unknown option ${optionId}`)
}
