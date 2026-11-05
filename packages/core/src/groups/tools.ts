/**
 * 群工具 (GRP-07): what a member can do in a group besides answering —
 * group_whisper (a private note), group_assign (a task with a deliverable),
 * group_pass (没有补充) — and, for the moderator, group_close (end the
 * turn with a summary, from any of its speeches, GRP-15) and, while it
 * plans the turn, group_next (who answers). They are registered once and
 * visible only to the root agent of a member's own session; a member's
 * subagents never see them. Members are named the way the charter lists
 * them (their full names); ids and a name start that fits one member work
 * too (GRP-15).
 */
import { z } from 'zod'
import type { Agent } from '../harness/agent/agent'
import {
  defineTool,
  ToolError,
  type ToolDefinition,
} from '../harness/tools/definition'
import { resolveName } from './envelope'
import type { GroupScheduler } from './scheduler'
import type { GroupWorkScheduler } from './work-scheduler'
import type { ContactId, GroupMember } from './types'

export const GROUP_TOOL_NAMES = [
  'group_whisper',
  'group_assign',
  'group_pass',
  'group_next',
  'group_close',
  'group_task_submit',
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
  /** CG-03: candidate submission is visible only during an active work run. */
  work?: Pick<GroupWorkScheduler, 'isWorking' | 'submit'>
}

export interface GroupToolRegistration {
  definition: ToolDefinition
  visible: (agent: Agent | undefined) => boolean
}

const memberName = z
  .string()
  .min(1)
  .describe(
    'A member of this group, by the full name the charter lists after @.',
  )

export function createGroupTools(host: GroupToolHost): GroupToolRegistration[] {
  const speaker = (agent: Agent | undefined) => {
    const member = host.memberOf(agent)
    if (!member) throw new ToolError('群工具只能在群聊里使用', 'GROUP_ONLY')
    return member
  }
  const resolve = (groupId: string, name: string): ContactId => {
    const roster = host.roster(groupId)
    const hit = resolveName(name, roster)
    if (hit.kind === 'member') return hit.id
    const names = (ids: readonly ContactId[]) =>
      roster
        .filter((m) => ids.includes(m.id))
        .map((m) => m.name)
        .join('、')
    throw new ToolError(
      hit.kind === 'ambiguous'
        ? `「${hit.token}」能对上好几位成员：${names(hit.ids)}，请写全名`
        : `「${hit.token}」不在这个群里。群里的成员：${names(roster.map((m) => m.id))}。`,
      'NOT_A_MEMBER',
    )
  }
  const nameOf = (groupId: string, id: ContactId) =>
    host.roster(groupId).find((m) => m.id === id)?.name ?? id
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
      return `已私信「${nameOf(groupId, to)}」。`
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
      idempotencyKey: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Stable delivery key; a replay must reuse the original task.',
        ),
      acceptance: z
        .array(z.string().min(1))
        .optional()
        .describe('Checks required before the result can be accepted.'),
      dependsOn: z
        .array(z.string().min(1))
        .optional()
        .describe('Task ids in this group that must be accepted first.'),
      writeScopes: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Declared write boundaries; Core still enforces the member root.',
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
          ...(args.idempotencyKey
            ? { idempotencyKey: args.idempotencyKey }
            : {}),
          ...(args.acceptance ? { acceptance: args.acceptance } : {}),
          ...(args.dependsOn ? { dependsOn: args.dependsOn } : {}),
          ...(args.writeScopes ? { writeScopes: args.writeScopes } : {}),
        }),
      )
      return `已交办给「${nameOf(groupId, to)}」：${task.title}`
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
      'Moderator only, and only when you are asked to plan who answers (the turn starts with you, or the loop ' +
      'guard asks you to step in): choose who answers next. relay: one after another, each seeing the ones ' +
      'before; independent: all at once, blind to each other, revealed together. In any other speech, ' +
      'write @ and the full name in your reply instead.',
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
      return `已安排：${speakers.map((id) => nameOf(groupId, id)).join('、')}。`
    },
  })

  const close = defineTool({
    name: 'group_close',
    description:
      'Moderator only: end this turn now with this summary — whenever you speak in it (planning, answering, ' +
      'doing a task), as soon as the question is answered or nothing new is coming. Nobody else speaks after it.',
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

  const submit = defineTool({
    name: 'group_task_submit',
    description:
      'During your current background task only: publish a file from your own member workspace as a candidate and attach real check evidence. A normal reply never changes task state.',
    input: z.object({
      sourcePath: z
        .string()
        .min(1)
        .describe(
          'A file in your own member workspace, absolute or relative to it.',
        ),
      checks: z
        .array(
          z.object({
            evidenceRef: z
              .string()
              .min(1)
              .describe(
                'The real tool result, test output or other check evidence.',
              ),
            passed: z.boolean(),
          }),
        )
        .max(100)
        .optional(),
    }),
    execute: async (args, context) => {
      if (!host.work)
        throw new ToolError('后台任务服务没有启动', 'GROUP_REFUSED')
      const task = run(() => host.work!.submit(context.agent, args))
      return `已提交候选成果：${task.artifacts?.at(-1)?.ref ?? task.taskId}`
    },
  })

  return [
    { definition: whisper, visible: member },
    { definition: assign, visible: member },
    { definition: pass, visible: member },
    { definition: next, visible: moderator },
    { definition: close, visible: moderator },
    {
      definition: submit,
      visible: (agent) => host.work?.isWorking(agent) === true,
    },
  ]
}
