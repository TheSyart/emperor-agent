// Trajectory input records (ported from the dsh
// trajectory-message-definitions): user and steering messages (classified
// through the shared next-step inbox ledger, display text merged from
// `host/user-meta`) and context messages; plus Emperor's durable harness
// facts rendered as context records (goal, hook, approval, permission /
// plan / sandbox mode, inbox splices, instruction and memory baselines).
import type {
  SessionEventMap,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationLink,
  ConversationMatch,
} from '../../../conversation/assembler'
import {
  contentText,
  isAppendSurfaceEvent,
  isEvent,
} from '../../../conversation/events'
import {
  findUserMeta,
  type InboxState,
  type UserMetaLedger,
} from '../../../conversation/nodes/ledgers'
import type {
  TrajectoryContextNode,
  TrajectorySteeringNode,
  TrajectoryUserNode,
} from '../contract'
import { textContent, trajectoryNode } from './common'

/** Shared chat ledgers (always registered by the chat target). */
const USER_META_LEDGER = 'user-meta'
const NEXT_STEP_INBOX_LEDGER = 'inbox-next-step'

type MessageNode =
  TrajectoryUserNode | TrajectorySteeringNode | TrajectoryContextNode

/** Model-visible messages: user, steering and context-source messages. */
export const trajectoryMessageDefinition: ConversationDefinition<MessageNode> =
  {
    kind: 'trajectory-input-message',
    target: 'trajectory',
    match: (event) =>
      isEvent(event, 'user/message') &&
      isAppendSurfaceEvent(event) &&
      (event.data.source.kind === 'user' ||
        event.data.source.kind === 'context')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match, reader) => {
      const event = match.event
      if (!isEvent(event, 'user/message'))
        throw new Error('trajectory-input-message start requires user/message')
      if (event.data.source.kind !== 'user') {
        return {
          kind: 'context',
          origin: 'message',
          seq: event.seq,
          time: event.time,
          content: event.data.content,
          source: event.data.source,
        }
      }
      const messageId = String(event.data.id)
      const meta = findUserMeta(
        reader.previous<UserMetaLedger>(USER_META_LEDGER),
        messageId,
      )
      const claimed =
        reader
          .previous<InboxState>(NEXT_STEP_INBOX_LEDGER)
          ?.state.claimed.has(messageId) === true
      const displayText = meta?.displayContent
      return {
        kind: claimed ? 'steering' : 'user',
        seq: event.seq,
        time: event.time,
        messageId,
        content: event.data.content,
        source: event.data.source,
        ...(displayText === undefined ||
        displayText === contentText(event.data.content)
          ? {}
          : { displayText }),
        ...(meta === undefined ? {} : { meta }),
      }
    },
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state === undefined
        ? null
        : trajectoryNode(context, context.state.seq, {
            kind: 'node',
            node: context.state,
          }),
  }

/** Event types rendered as context records. */
const CONTEXT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'goal/change',
  'goal/round',
  'hook/invoked',
  'approval/asked',
  'approval/policy',
  'permission/preset',
  'plan/mode',
  'sandbox/mode',
  'working-directory/change',
  'agent/inbox/spliced',
  'instructions/baseline',
  'memory/baseline',
])

interface ContextFacts {
  readonly label: string
  readonly text: string
  readonly durationMs?: number
  readonly isError?: boolean
}

function hookFacts(
  invoked: SessionEventMap['hook/invoked'],
  result: SessionEventMap['hook/result'] | undefined,
): ContextFacts {
  const lines = [
    `${invoked.dialect}${invoked.matcher === undefined ? '' : ` · ${invoked.matcher}`}`,
    result === undefined
      ? '运行中'
      : [
          `决定：${result.decision}`,
          result.exitCode === undefined
            ? undefined
            : `退出码 ${result.exitCode}`,
        ]
          .filter((part) => part !== undefined)
          .join(' · '),
    result?.stderrSummary,
  ].filter((line): line is string => line !== undefined && line !== '')
  return {
    label: `Hook · ${invoked.point}`,
    text: lines.join('\n'),
    ...(result === undefined ? {} : { durationMs: result.durationMs }),
    ...(result?.exitCode !== undefined && result.exitCode !== 0
      ? { isError: true }
      : {}),
  }
}

function inboxFacts(
  data: SessionEventMap['agent/inbox/spliced'],
): ContextFacts {
  const inserted = data.inserted.length
  const removed = data.removedCount ?? 0
  const parts = [
    inserted > 0 ? `排队 ${inserted}` : undefined,
    removed > 0
      ? `${data.outcome === 'canceled' ? '丢弃' : '接收'} ${removed}`
      : undefined,
  ].filter((part): part is string => part !== undefined)
  const previews = data.inserted
    .map((message) => contentText(message.content).trim())
    .filter((text) => text !== '')
  return {
    label: `收件箱 · ${data.target}`,
    text: [parts.join(' · ') || '无变化', ...previews].join('\n'),
  }
}

function eventFacts(
  event: WireSessionEvent,
  settled: WireSessionEvent | undefined,
): ContextFacts | undefined {
  if (isEvent(event, 'goal/change')) {
    const data = event.data
    if (data.operation === 'clear')
      return { label: '目标', text: `清除 · ${data.cleared.id}` }
    const goal = data.goal
    return {
      label: '目标',
      text: [
        `${data.operation} · ${goal.phase}`,
        goal.objective,
        goal.blockedReason === undefined
          ? undefined
          : `受阻：${goal.blockedReason.message}`,
      ]
        .filter((line): line is string => line !== undefined && line !== '')
        .join('\n'),
      ...(goal.phase === 'blocked' ? { isError: true } : {}),
    }
  }
  if (isEvent(event, 'goal/round'))
    return { label: '目标轮次', text: `第 ${event.data.round} 轮` }
  if (isEvent(event, 'hook/invoked'))
    return hookFacts(
      event.data,
      settled !== undefined && isEvent(settled, 'hook/result')
        ? settled.data
        : undefined,
    )
  if (isEvent(event, 'approval/asked')) {
    const outcome =
      settled !== undefined && isEvent(settled, 'approval/decided')
        ? settled.data.outcome
        : '待定'
    return {
      label: `审批 · ${event.data.toolName}`,
      text: [outcome, event.data.reason]
        .filter((line): line is string => line !== undefined && line !== '')
        .join('\n'),
      ...(outcome === 'rejected' ? { isError: true } : {}),
    }
  }
  if (isEvent(event, 'approval/policy'))
    return {
      label: '审批策略',
      text: `${event.data.policy}${event.data.source === undefined ? '' : ` · ${event.data.source}`}`,
    }
  if (isEvent(event, 'permission/preset'))
    return { label: '权限预设', text: event.data.preset }
  if (isEvent(event, 'plan/mode'))
    return { label: '计划模式', text: event.data.active ? '开' : '关' }
  if (isEvent(event, 'sandbox/mode'))
    return {
      label: '沙箱模式',
      text: `${event.data.mode}${event.data.source === undefined ? '' : ` · ${event.data.source}`}`,
    }
  if (isEvent(event, 'working-directory/change'))
    return {
      label: '工作目录',
      text: `${event.data.to}\n${event.data.reason} · 原目录 ${event.data.from}`,
    }
  if (isEvent(event, 'agent/inbox/spliced')) return inboxFacts(event.data)
  if (isEvent(event, 'instructions/baseline'))
    return { label: '工作区说明', text: event.data.files.join('\n') }
  if (isEvent(event, 'memory/baseline'))
    return { label: '记忆', text: `摘要 ${event.data.digest}` }
  return undefined
}

function isContextEvent(event: WireSessionEvent): boolean {
  if (!CONTEXT_EVENT_TYPES.has(event.type)) return false
  // Empty baselines carry no model-visible context.
  if (isEvent(event, 'instructions/baseline'))
    return event.data.files.length > 0
  if (isEvent(event, 'memory/baseline')) return event.data.digest !== ''
  return true
}

interface EventContextState {
  readonly start: ConversationMatch
  readonly settled: ConversationMatch | undefined
}

/**
 * Durable harness facts as context records. `hook/result` and
 * `approval/decided` settle their invocation through links (the hook
 * handlerId is process-local, so the invocation seq is the identity).
 */
export const trajectoryEventContextDefinition: ConversationDefinition<EventContextState> =
  {
    kind: 'trajectory-event-context',
    target: 'trajectory',
    links: (event) => {
      const links: ConversationLink[] = []
      if (isEvent(event, 'hook/invoked'))
        links.push({
          ns: 'handler',
          key: event.data.handlerId,
          id: String(event.seq),
        })
      if (isEvent(event, 'approval/asked'))
        links.push({
          ns: 'approval',
          key: event.data.id,
          id: String(event.seq),
        })
      return links
    },
    match: (event) => {
      if (isContextEvent(event)) return { id: String(event.seq), role: 'start' }
      if (isEvent(event, 'hook/result'))
        return {
          via: { ns: 'handler', key: event.data.handlerId },
          role: 'update',
        }
      if (isEvent(event, 'approval/decided'))
        return { via: { ns: 'approval', key: event.data.id }, role: 'update' }
      return null
    },
    start: (_context, match) => ({ start: match, settled: undefined }),
    update: (context, match) => ({ ...context.state, settled: match }),
    buildViewNode: (context) => {
      const state = context.state
      if (state === undefined) return null
      const event = state.start.event
      const facts = eventFacts(event, state.settled?.event)
      if (facts === undefined) return null
      const node: TrajectoryContextNode = {
        kind: 'context',
        origin: 'event',
        seq: event.seq,
        time: event.time,
        eventType: event.type,
        label: facts.label,
        content: textContent(facts.text),
        source: {
          kind: 'event',
          type: event.type,
          data: event.data,
          ...(state.settled === undefined
            ? {}
            : { settled: state.settled.event.data }),
        },
        ...(facts.durationMs === undefined
          ? {}
          : { durationMs: facts.durationMs }),
        ...(facts.isError === true ? { isError: true } : {}),
      }
      return trajectoryNode(context, event.seq, { kind: 'node', node })
    },
  }
