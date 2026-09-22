/**
 * Advisory per-agent repeat-call detector (ported from
 * dsh-repeat-tool-reminder). Tracks consecutive identical calls (tool name +
 * canonical JSON arguments) per agent and, when a run length hits a
 * configured threshold, attaches a nudge as an `additionalContexts` notice.
 * It never vetoes or rewrites a call.
 *
 * Counting happens in post-execute because denied calls flow through the same
 * pipeline — a model hammering a denied call is exactly the loop worth
 * breaking. Untracked tools (see `include`/`exclude`) are transparent: they
 * neither count nor reset the chain. A user interjection resets the chain:
 * push {@link RepeatReminder.preStep} onto `AgentMiddleware.preStep`.
 */

import { contextMessage, type UserMessage } from '../../llm/message'
import type { Agent } from '../agent/agent'
import type { PreStepMiddleware } from '../agent/middleware'
import type { PostExecuteMiddleware, ToolCallInfo } from './registry'

export const REPEAT_REMINDER_PRODUCER = 'repeat-tool-reminder'

/** The gentle first-threshold reminder. */
export const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. ' +
  'Carefully analyze the previous result before calling again: if the task is ' +
  'not complete, try a different approach or different arguments instead of ' +
  'repeating the call.'

/** The detailed later-threshold reminder naming the tool, the run length, and the canonical arguments. */
export function detailedReminder(
  toolName: string,
  count: number,
  canonicalArguments: string,
): string {
  return (
    'Repeated tool call detected:\n' +
    `- tool: ${toolName}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    'The repeated calls are not making progress. Do not call this tool with ' +
    'these exact arguments again. Inspect the latest result and choose a ' +
    'different action, different arguments, or finish the task if enough ' +
    'evidence has been gathered.'
  )
}

export interface RepeatReminderOptions {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: readonly number[]
  /** `*`-wildcard tool-name patterns to track; empty means every tool. */
  include?: readonly string[]
  /** `*`-wildcard tool-name patterns transparent to the chain. */
  exclude?: readonly string[]
  /** Max characters of canonical arguments quoted in the detailed reminder (default 500). */
  argumentsPreviewChars?: number
}

/** The post-execute middleware plus its chain-reset companions. */
export type RepeatReminder = PostExecuteMiddleware & {
  /** Pre-step middleware: resets the agent's chain when a user message enters. */
  readonly preStep: PreStepMiddleware
  /** Forget one agent's chain. */
  reset(agent: Agent): void
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort())
      sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

/** Canonical string form of call arguments: deep key-sort, then stringify. */
export function canonicalArguments(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? 'null'
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

function validateThresholds(values: readonly number[]): number[] {
  if (values.length === 0)
    throw new Error('repeat-tool-reminder: `thresholds` must not be empty')
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(
        `repeat-tool-reminder: invalid threshold ${value} — every threshold must be an integer >= 2`,
      )
    }
  }
  if (new Set(values).size !== values.length)
    throw new Error(
      'repeat-tool-reminder: `thresholds` must not contain duplicates',
    )
  return [...values].sort((a, b) => a - b)
}

interface Chain {
  key: string
  count: number
}

/** Create the repeat-call reminder middleware. */
export function createRepeatReminder(
  options: RepeatReminderOptions = {},
): RepeatReminder {
  const thresholds = validateThresholds(options.thresholds ?? [3, 5, 8])
  const thresholdSet = new Set(thresholds)
  const include = (options.include ?? []).map(wildcardToRegExp)
  const exclude = (options.exclude ?? []).map(wildcardToRegExp)
  const previewChars = options.argumentsPreviewChars ?? 500
  if (!Number.isInteger(previewChars) || previewChars < 1) {
    throw new Error(
      `repeat-tool-reminder: invalid argumentsPreviewChars ${previewChars} — must be an integer >= 1`,
    )
  }
  const chains = new WeakMap<Agent, Chain>()

  const tracked = (name: string): boolean => {
    if (include.length > 0 && !include.some((pattern) => pattern.test(name)))
      return false
    return !exclude.some((pattern) => pattern.test(name))
  }

  const observe = (call: ToolCallInfo): UserMessage | undefined => {
    if (call.agent === undefined || !tracked(call.name)) return undefined
    const canonical = canonicalArguments(call.arguments)
    const key = JSON.stringify([call.name, canonical])
    const chain = chains.get(call.agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    chains.set(call.agent, { key, count })
    if (!thresholdSet.has(count)) return undefined
    const text =
      count === thresholds[0]
        ? GENTLE_REMINDER
        : detailedReminder(
            call.name,
            count,
            previewArguments(canonical, previewChars),
          )
    return contextMessage(REPEAT_REMINDER_PRODUCER, text, {
      form: 'notice',
      summary: `${call.name} × ${count}`,
    })
  }

  const middleware: PostExecuteMiddleware = (call) => {
    const reminder = observe(call)
    return reminder === undefined
      ? undefined
      : { kind: 'accept', additionalContexts: [reminder] }
  }
  const preStep: PreStepMiddleware = ({ agent, messages }) => {
    if (messages.some((message) => message.source.kind === 'user'))
      chains.delete(agent)
    return undefined
  }
  return Object.assign(middleware, {
    preStep,
    reset(agent: Agent) {
      chains.delete(agent)
    },
  })
}
