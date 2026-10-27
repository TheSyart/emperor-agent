/**
 * What a new group message puts in the speaking queue (GRP-07). Pure: the
 * scheduler executes the items. There is no quota here or anywhere: a turn
 * ends when the queue empties, the moderator closes it, the loop guard
 * steps in or the user stops it.
 *
 * - An @ asks those members in @ order (relay); independent answers are one
 *   blind batch.
 * - A broadcast from the user follows the collaboration mode: autonomous
 *   polls the members who speak when relevant (raise a hand) and queues
 *   those who always speak; moderated hands it to the moderator to plan
 *   (falling back to the poll without one); quiet mode starts nobody.
 * - Under moderated, a member's @ or task to others is reviewed by the
 *   moderator first; the user's and the moderator's never are.
 * - A member message that @-mentions nobody ends that line.
 */
import type { GroupState } from './events'
import type { ContactId, GroupMember, GroupMessage, GroupTask } from './types'

export type QueueItem =
  | {
      kind: 'speak'
      member: ContactId
      reason: 'asked' | 'mention' | 'moderator-plan' | 'always'
      source: string
    }
  | { kind: 'batch'; members: ContactId[]; batchId: string; source: string }
  | { kind: 'poll'; members: ContactId[]; source: string }
  | { kind: 'review'; reviewer: ContactId; message: string; source: string }
  | { kind: 'task'; task: GroupTask; source: string }
  | { kind: 'notice'; text: string; source: string }

const QUIET =
  '安静模式下只有被 @ 的成员发言：@ 一位成员，或在群设置里关掉安静模式。'

function broadcast(
  message: GroupMessage,
  state: GroupState,
  roster: readonly GroupMember[],
): QueueItem[] {
  const source = message.id
  if (state.settings.quiet) return [{ kind: 'notice', text: QUIET, source }]
  if (state.settings.collaboration === 'moderated' && state.moderator)
    return [
      {
        kind: 'speak',
        member: state.moderator,
        reason: 'moderator-plan',
        source,
      },
    ]
  const members = state.members
    .map((id) => roster.find((m) => m.id === id))
    .filter((m): m is GroupMember => Boolean(m))
  const poll = members
    .filter((m) => (m.speak ?? 'relevant') === 'relevant')
    .map((m) => m.id)
  const always = members.filter((m) => m.speak === 'always').map((m) => m.id)
  return [
    ...(poll.length ? [{ kind: 'poll' as const, members: poll, source }] : []),
    ...always.map((member) => ({
      kind: 'speak' as const,
      member,
      reason: 'always' as const,
      source,
    })),
  ]
}

export function planFor(
  message: GroupMessage,
  state: GroupState,
  roster: readonly GroupMember[],
): QueueItem[] {
  const source = message.id
  const fromMember = message.from !== 'user' && message.from !== 'system'
  const reviewed =
    fromMember &&
    state.settings.collaboration === 'moderated' &&
    state.moderator !== null &&
    message.from !== state.moderator
  if (message.kind === 'task' && message.task) {
    if (reviewed)
      return [
        {
          kind: 'review',
          reviewer: state.moderator!,
          message: message.id,
          source,
        },
      ]
    return [{ kind: 'task', task: message.task, source }]
  }
  const ask = message.ask.filter(
    (id) => id !== message.from && state.members.includes(id),
  )
  if (ask.length) {
    if (reviewed)
      return [
        {
          kind: 'review',
          reviewer: state.moderator!,
          message: message.id,
          source,
        },
      ]
    if (message.answerMode === 'independent' && message.batchId)
      return [{ kind: 'batch', members: ask, batchId: message.batchId, source }]
    return ask.map((member) => ({
      kind: 'speak' as const,
      member,
      reason: fromMember ? ('mention' as const) : ('asked' as const),
      source,
    }))
  }
  if (message.from === 'user' && message.audience.kind === 'all')
    return broadcast(message, state, roster)
  return []
}

/**
 * The chain a task carries once `from` hands it to `to`. A task never goes
 * back up its chain (A → B → A), which would loop without a quota to stop it.
 */
export function assignTask(
  from: ContactId,
  to: ContactId,
  chain: readonly ContactId[],
): ContactId[] {
  if (from === to) throw new Error('不能把任务交办给自己')
  if (chain.includes(to))
    throw new Error('交办链不能绕回：这个任务已经经过对方')
  return [...chain, from]
}
