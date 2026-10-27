/**
 * 群工具 (GRP-07): what a member can do in a group besides answering —
 * group_whisper (a private note), group_assign (a task with a deliverable),
 * group_pass (没有补充) — and, for the moderator while it plans the turn,
 * group_next (who answers) and group_close (end with a summary). They are
 * registered once and visible only to the root agent of a member's own
 * session; a member's subagents never see them. Members are named the way
 * the charter lists them (their names); ids work too.
 */
import { z } from 'zod'
import type { Agent } from '../harness/agent/agent'
import {
  defineTool,
  ToolError,
  type ToolDefinition,
} from '../harness/tools/definition'
import type { GroupScheduler } from './scheduler'
import type { ContactId, GroupMember } from './types'

export const GROUP_TOOL_NAMES = [
  'group_whisper',
  'group_assign',
  'group_pass',
  'group_next',
  'group_close',
] as const
export const MODERATOR_TOOL_NAMES: readonly string[] = [
  'group_next',
  'group_close',
]

export interface GroupToolHost {
  /** The member a member session's root agent speaks as; null for any other agent. */
  memberOf(
    agent: Agent | undefined,
  ): { groupId: string; contactId: ContactId } | null
  moderatorOf(groupId: string): ContactId | null
  roster(groupId: string): readonly GroupMember[]
  scheduler: Pick<
    GroupScheduler,
    'whisper' | 'assign' | 'pass' | 'next' | 'close'
  >
}

export interface GroupToolRegistration {
  definition: ToolDefinition
  visible: (agent: Agent | undefined) => boolean
}

const memberName = z
  .string()
  .min(1)
  .describe('A member of this group, by the name the charter lists.')

export function createGroupTools(host: GroupToolHost): GroupToolRegistration[] {
  const speaker = (agent: Agent | undefined) => {
    const member = host.memberOf(agent)
    if (!member) throw new ToolError('群工具只能在群聊里使用', 'GROUP_ONLY')
    return member
  }
  const resolve = (groupId: string, name: string): ContactId => {
    const wanted = name.trim().replace(/^@/, '')
    const found = host
      .roster(groupId)
      .find((m) => m.id === wanted || m.name === wanted)
    if (!found) throw new ToolError(`「${wanted}」不在这个群里`, 'NOT_A_MEMBER')
    return found.id
  }
  const run = <T>(body: () => T): T => {
    try {
      return body()
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(
        error instanceof Error ? error.message : String(error),
        'GROUP_REFUSED',
      )
    }
  }
  const member = (agent: Agent | undefined) => host.memberOf(agent) !== null
  const moderator = (agent: Agent | undefined) => {
    const who = host.memberOf(agent)
    return who !== null && host.moderatorOf(who.groupId) === who.contactId
  }

  const whisper = defineTool({
    name: 'group_whisper',
    description:
      'Send a private note to one member of this group: only they (and the user) see it. ' +
      'It does not ask them to answer now; they read it the next time they speak.',
    input: z.object({
      to: memberName,
      text: z.string().min(1).describe('The note.'),
    }),
    execute: async (args, context) => {
      const { groupId, contactId } = speaker(context.agent)
      const to = resolve(groupId, args.to)
      run(() =>
        host.scheduler.whisper(groupId, contactId, { to, text: args.text }),
      )
      return `已私信「${args.to.replace(/^@/, '')}」。`
    },
  })

  const assign = defineTool({
    name: 'group_assign',
    description:
      'Hand a task with a clear deliverable to another member; they work on it after you and post ' +
      'the result to the group. A task never goes back to anyone who handed it down to you.',
    input: z.object({
      to: memberName,
      title: z.string().min(1).describe('The task, in one line.'),
      deliverable: z
        .string()
        .min(1)
        .describe('What they hand back, and in what form.'),
      basis: z
        .string()
        .optional()
        .describe('What it builds on: a message, a file, a decision.'),
      access: z
        .enum(['group_files', 'readonly', 'isolated_worktree'])
        .describe(
          'group_files: may write the group files; readonly: reads only; ' +
            'isolated_worktree: changes code in a worktree of its own.',
        ),
    }),
    execute: async (args, context) => {
      const { groupId, contactId } = speaker(context.agent)
      const to = resolve(groupId, args.to)
      const task = run(() =>
        host.scheduler.assign(groupId, contactId, {
          to,
          title: args.title,
          deliverable: args.deliverable,
          ...(args.basis ? { basis: args.basis } : {}),
          access: args.access,
        }),
      )
      return `已交办给「${args.to.replace(/^@/, '')}」：${task.title}`
    },
  })

  const pass = defineTool({
    name: 'group_pass',
    description:
      'Say you have nothing to add (没有补充) instead of repeating what others said. Ends your speech.',
    input: z.object({
      reason: z.string().optional().describe('One short line, optional.'),
    }),
    execute: async (args, context) => {
      const { groupId, contactId } = speaker(context.agent)
      run(() => host.scheduler.pass(groupId, contactId, args.reason))
      context.concludeTurn()
      return '已表示没有补充。'
    },
  })

  const next = defineTool({
    name: 'group_next',
    description:
      'Moderator only, while you plan the turn: choose who answers next. relay: one after another, ' +
      'each seeing the ones before; independent: all at once, blind to each other, revealed together.',
    input: z.object({
      speakers: z.array(memberName).min(1).describe('Who answers, in order.'),
      mode: z.enum(['relay', 'independent']),
      note: z
        .string()
        .optional()
        .describe('What you want from them, one line.'),
    }),
    execute: async (args, context) => {
      const { groupId, contactId } = speaker(context.agent)
      const speakers = args.speakers.map((name) => resolve(groupId, name))
      run(() =>
        host.scheduler.next(groupId, contactId, {
          speakers,
          mode: args.mode,
          ...(args.note ? { note: args.note } : {}),
        }),
      )
      return `已安排：${args.speakers.join('、')}。`
    },
  })

  const close = defineTool({
    name: 'group_close',
    description:
      'Moderator only, while you plan the turn: end it with this summary when no discussion is needed.',
    input: z.object({
      summary: z.string().min(1).describe('The conclusion the group reads.'),
    }),
    execute: async (args, context) => {
      const { groupId, contactId } = speaker(context.agent)
      run(() => host.scheduler.close(groupId, contactId, args.summary))
      context.concludeTurn()
      return '已收尾。'
    },
  })

  return [
    { definition: whisper, visible: member },
    { definition: assign, visible: member },
    { definition: pass, visible: member },
    { definition: next, visible: moderator },
    { definition: close, visible: moderator },
  ]
}
