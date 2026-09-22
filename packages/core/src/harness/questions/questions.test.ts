import { describe, expect, it } from 'vitest'
import { userText } from '../../llm/message'
import type { SessionEvent } from '../../session-log/types'
import { createTestHarness } from '../testing'
import { textOf } from '../tools/definition'
import {
  createAskUserQuestionTool,
  DELEGATED_CALLER_MESSAGE,
  questionRepair,
  UserQuestionService,
  type UserQuestionRequest,
} from './index'

const QUESTIONS = [
  {
    id: 'mode',
    question: 'Which mode?',
    options: [{ label: 'fast' }, { label: 'safe', description: 'slower' }],
  },
]

function openAgent(
  options?: Parameters<ReturnType<typeof createTestHarness>['agent']>[1],
) {
  const h = createTestHarness()
  const agent = h.agent(undefined, options)
  agent.session.append('turn/start', { turn: 1 })
  return { h, agent }
}

function questionEvents(events: readonly SessionEvent[]) {
  return events.filter(
    (e) => e.type === 'question/asked' || e.type === 'question/answered',
  )
}

describe('UserQuestionService', () => {
  it('asks the answerer and logs asked + answered', async () => {
    const service = new UserQuestionService()
    const seen: Array<UserQuestionRequest & { id: string }> = []
    service.setAnswerer(async (request) => {
      seen.push(request)
      return { mode: { selected: ['safe'] }, bogus: { selected: ['x'] } }
    })
    const { agent } = openAgent()
    const outcome = await service.ask({
      agent,
      callId: 'c1',
      questions: QUESTIONS,
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({
      outcome: 'answered',
      answers: { mode: { selected: ['safe'] } },
    })
    const events = questionEvents(agent.session.events)
    expect(events.map((e) => e.type)).toEqual([
      'question/asked',
      'question/answered',
    ])
    expect(events[0]!.data).toMatchObject({
      id: seen[0]!.id,
      callId: 'c1',
      questions: QUESTIONS,
    })
    expect(events[1]!.data).toEqual({
      id: seen[0]!.id,
      answers: { mode: { selected: ['safe'] } },
    })
  })

  it('settles cancelled on abort', async () => {
    const service = new UserQuestionService()
    service.setAnswerer(() => new Promise(() => {}))
    const { agent } = openAgent()
    const controller = new AbortController()
    const pending = service.ask({
      agent,
      questions: QUESTIONS,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).resolves.toEqual({ outcome: 'cancelled' })
    expect(agent.session.lastOf('question/answered')?.data).toMatchObject({
      outcome: 'cancelled',
    })
  })

  it('is unavailable without an answerer or when the answerer throws', async () => {
    const service = new UserQuestionService()
    const { agent } = openAgent()
    await expect(service.ask({ agent, questions: QUESTIONS })).resolves.toEqual(
      { outcome: 'unavailable' },
    )
    service.setAnswerer(async () => {
      throw new Error('ui gone')
    })
    await expect(service.ask({ agent, questions: QUESTIONS })).resolves.toEqual(
      { outcome: 'unavailable' },
    )
    expect(questionEvents(agent.session.events)).toHaveLength(4)
  })

  it('refuses delegated child agents before logging', async () => {
    const service = new UserQuestionService()
    service.setAnswerer(async () => ({}))
    const { h, agent: parent } = openAgent()
    const child = h.agent('child', { owner: parent })
    child.session.append('turn/start', { turn: 1 })
    await expect(
      service.ask({ agent: child, questions: QUESTIONS }),
    ).rejects.toMatchObject({
      code: 'DELEGATED_CALLER',
      message: DELEGATED_CALLER_MESSAGE,
    })
    expect(questionEvents(child.session.events)).toHaveLength(0)
  })

  it('validates plan-review intents and requires an open turn', async () => {
    const service = new UserQuestionService()
    const { agent } = openAgent()
    await expect(
      service.ask({
        agent,
        questions: QUESTIONS,
        intent: { kind: 'plan-review', approve: 'nope' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_INTENT' })
    await expect(
      service.ask({
        agent,
        questions: QUESTIONS,
        intent: { kind: 'plan-review', approve: 'fast' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_INTENT' })
    await expect(service.ask({ agent, questions: [] })).rejects.toMatchObject({
      code: 'EMPTY_QUESTIONS',
    })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(service.ask({ agent, questions: QUESTIONS })).rejects.toThrow(
      'outside an open turn',
    )
  })

  it('repair closes unanswered asks as unavailable', () => {
    const events = [
      {
        type: 'question/asked',
        seq: 1,
        time: 0,
        data: { id: 'q1', questions: QUESTIONS },
      },
      {
        type: 'question/asked',
        seq: 2,
        time: 0,
        data: { id: 'q2', questions: QUESTIONS },
      },
      {
        type: 'question/answered',
        seq: 3,
        time: 0,
        data: { id: 'q1', answers: {} },
      },
    ] as SessionEvent[]
    expect(questionRepair(events)).toEqual([
      { type: 'question/answered', data: { id: 'q2', outcome: 'unavailable' } },
    ])
  })
})

describe('ask_user_question tool', () => {
  it('exposes the dsh schema field names', () => {
    const tool = createAskUserQuestionTool(new UserQuestionService())
    const items = (tool.parameters as any).properties.questions.items
      .properties as Record<string, unknown>
    expect(Object.keys(items).sort()).toEqual([
      'header',
      'id',
      'multi_select',
      'options',
      'question',
    ])
  })

  it('runs end to end: model asks, answerer replies, model sees the answers', async () => {
    const service = new UserQuestionService()
    let asked: UserQuestionRequest | undefined
    service.setAnswerer(async (request) => {
      asked = request
      return { mode: { selected: ['fast'], custom: 'but careful' } }
    })
    const h = createTestHarness({
      replies: [
        {
          tools: [
            {
              id: 'ask1',
              name: 'ask_user_question',
              args: {
                questions: [
                  {
                    id: 'mode',
                    question: 'Which mode?',
                    header: 'Mode',
                    options: [{ label: 'fast' }],
                    multi_select: true,
                  },
                ],
              },
            },
          ],
        },
        { text: 'thanks' },
      ],
    })
    h.tools.register(createAskUserQuestionTool(service))
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(asked?.callId).toBe('ask1')
    expect(asked?.questions).toEqual([
      {
        id: 'mode',
        question: 'Which mode?',
        header: 'Mode',
        options: [{ label: 'fast' }],
        multiSelect: true,
      },
    ])
    const result = agent.session.lastOf('tool/result')!
    const block = result.data.message.content[0]
    expect(block.isError).toBe(false)
    expect(textOf(block.content)).toBe(
      JSON.stringify({
        answers: [{ id: 'mode', selected: ['fast'], custom: 'but careful' }],
      }),
    )
    expect(result.data.meta).toEqual({
      answers: { mode: { selected: ['fast'], custom: 'but careful' } },
    })
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
  })

  it('reports unavailable as a tool error', async () => {
    const h = createTestHarness({
      replies: [
        {
          tools: [
            {
              id: 'a',
              name: 'ask_user_question',
              args: { questions: QUESTIONS },
            },
          ],
        },
        { text: 'ok' },
      ],
    })
    h.tools.register(createAskUserQuestionTool(new UserQuestionService()))
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    const block = agent.session.lastOf('tool/result')!.data.message.content[0]
    expect(block.isError).toBe(true)
    expect(textOf(block.content)).toBe(
      'Error: no user-questions answerer is available',
    )
  })
})
