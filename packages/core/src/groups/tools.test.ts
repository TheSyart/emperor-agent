// GRP-07 · 群工具: visible only to a member session's root agent (the
// moderator's two only to the moderator), members named as the charter
// lists them, and every refusal read back to the model.
import { describe, expect, it } from 'vitest'
import type { Agent } from '../harness/agent/agent'
import type { ToolRunContext } from '../harness/tools/definition'
import { GroupScheduler } from './scheduler'
import { createGroupTools, GROUP_TOOL_NAMES } from './tools'
import { memoryGroups } from './test-fixture'

function setup() {
  const groups = memoryGroups()
  const calls: string[] = []
  const tools: ReturnType<typeof createGroupTools> = []
  const scheduler: GroupScheduler = new GroupScheduler({
    groups: groups.service,
    speak: async (req) => {
      const agent = { id: req.memberSessionId } as Agent
      const tool = (name: string) =>
        tools.find((t) => t.definition.name === name)!.definition
      const context = (name: string) =>
        ({
          callId: 'c',
          name,
          arguments: {},
          agent,
          signal: new AbortController().signal,
          deferContext: () => {},
          concludeTurn: () => calls.push(`conclude:${name}`),
        }) as unknown as ToolRunContext
      const use = async (name: string, args: unknown) => {
        try {
          calls.push(
            String(
              await tool(name).execute(tool(name).parse(args), context(name)),
            ),
          )
        } catch (error) {
          calls.push(`error:${(error as Error).message}`)
        }
      }
      if (req.member === 'ct-arch') {
        await use('group_whisper', { to: '审稿人', text: '私下说' })
        await use('group_whisper', { to: '产品经理', text: '?' })
        await use('group_assign', {
          to: '@审稿人',
          title: '查溢出',
          deliverable: '原因',
          access: 'readonly',
        })
        await use('group_next', { speakers: ['审稿人'], mode: 'relay' })
        await use('group_pass', { reason: '先这样' })
      }
      return { text: '', outcome: 'completed', spend: { usd: 0, tokens: 0 } }
    },
    poll: async () => ({ raise: false, score: 0, reason: '' }),
    review: async () => ({ verdict: 'approve' }),
    digest: async () => '',
  })
  const view = groups.service.create({
    title: '评审',
    members: ['ct-emperor', 'ct-arch', 'ct-rev'],
    settings: { summarizeAtEnd: false },
  })
  const sessionOf = (contact: string) =>
    groups.service.get(view.id).members.find((m) => m.id === contact)!
      .memberSessionId!
  tools.push(
    ...createGroupTools({
      memberOf: (agent) => {
        if (!agent || (agent as { owner?: unknown }).owner) return null
        const member = groups.service
          .get(view.id)
          .members.find((m) => m.memberSessionId === agent.id)
        return member ? { groupId: view.id, contactId: member.id } : null
      },
      moderatorOf: (id) => groups.service.get(id).moderator,
      roster: (id) => groups.service.roster(groups.service.state(id)),
      scheduler,
    }),
  )
  return { groups, view, scheduler, tools, calls, sessionOf }
}

describe('group tools', () => {
  it('registers the five tools', () => {
    const { tools } = setup()
    expect(tools.map((t) => t.definition.name)).toEqual([...GROUP_TOOL_NAMES])
  })

  it('shows them to a member session’s agent only, the moderator’s two to the moderator', () => {
    const { tools, sessionOf } = setup()
    const visibleTo = (agent: Agent | undefined) =>
      tools.filter((t) => t.visible(agent)).map((t) => t.definition.name)
    const member = { id: sessionOf('ct-arch') } as Agent
    const moderator = { id: sessionOf('ct-emperor') } as Agent
    const child = { id: 'child', owner: member } as unknown as Agent
    expect(visibleTo(member)).toEqual([
      'group_whisper',
      'group_assign',
      'group_pass',
    ])
    expect(visibleTo(moderator)).toEqual([...GROUP_TOOL_NAMES])
    expect(visibleTo(child)).toEqual([])
    expect(visibleTo({ id: 'some-chat' } as Agent)).toEqual([])
    expect(visibleTo(undefined)).toEqual([])
  })

  it('8 · whisper, assign and pass from a speech; refusals come back to the model', async () => {
    const { groups, view, scheduler, calls } = setup()
    const { message, plan } = groups.service.send(view.id, {
      way: 'mention',
      text: '@架构师 说说',
    })
    await scheduler.start(view.id, message, plan)
    expect(calls).toEqual([
      '已私信「审稿人」。',
      'error:「产品经理」不在这个群里',
      '已交办给「审稿人」：查溢出',
      'error:只有主持人安排发言时才能用 group_next',
      'conclude:group_pass',
      '已表示没有补充。',
    ])
    const kinds = groups.service
      .state(view.id)
      .messages.filter((m) => m.from === 'ct-arch')
      .map((m) => m.kind)
    expect(kinds).toEqual(['say', 'task', 'pass'])
  })

  it('refuses a group tool outside a speech', async () => {
    const { tools, sessionOf } = setup()
    const whisper = tools[0]!.definition
    await expect(
      whisper.execute(whisper.parse({ to: '审稿人', text: 'hi' }), {
        agent: { id: sessionOf('ct-arch') } as Agent,
      } as unknown as ToolRunContext),
    ).rejects.toThrow(/轮到你发言/)
  })
})
