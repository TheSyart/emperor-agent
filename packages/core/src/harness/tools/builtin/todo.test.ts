import { describe, expect, it } from 'vitest'
import { userText } from '../../../llm/message'
import { createTestHarness } from '../../testing'
import { textOf } from '../definition'
import { createTodoTool, currentTodos } from './todo'

function lastResult(
  events: readonly import('../../../session-log/types').SessionEvent[],
) {
  const results = events.filter((e) => e.type === 'tool/result')
  const event = results[results.length - 1]
  if (event?.type !== 'tool/result') throw new Error('no tool result')
  const block = event.data.message.content[0]
  return {
    text: textOf(block.content),
    isError: block.isError,
    meta: event.data.meta,
  }
}

async function run(
  args: unknown,
  config?: { allowParallelInProgress: boolean },
) {
  const h = createTestHarness({
    replies: [
      { tools: [{ id: 't1', name: 'todo_write', args }] },
      { text: 'ok' },
    ],
  })
  h.tools.register(createTodoTool(config))
  const agent = h.agent()
  agent.followup(userText('plan'))
  await agent.whenIdle()
  return agent
}

describe('todo_write', () => {
  it('replaces the whole list, appends todo/write, and reports counts', async () => {
    const h = createTestHarness({
      replies: [
        {
          tools: [
            {
              id: 'a',
              name: 'todo_write',
              args: {
                todos: [
                  { content: 'one', status: 'pending' },
                  { content: 'two', status: 'pending' },
                ],
              },
            },
          ],
        },
        {
          tools: [
            {
              id: 'b',
              name: 'todo_write',
              args: { todos: [{ content: ' one ', status: 'completed' }] },
            },
          ],
        },
        { text: 'done' },
      ],
    })
    h.tools.register(createTodoTool())
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    const writes = agent.session.events.filter((e) => e.type === 'todo/write')
    expect(writes).toHaveLength(2)
    expect(currentTodos(agent.session.events)).toEqual([
      { content: 'one', status: 'completed' },
    ])
    const result = lastResult(agent.session.events)
    expect(result.text).toBe(
      'Updated todo list: 0 pending, 0 in progress, 1 completed.',
    )
    expect(result.meta).toEqual({
      todos: [{ content: 'one', status: 'completed' }],
      counts: { pending: 0, inProgress: 0, completed: 1 },
    })
  })

  it('allows several in_progress items by default (standard preset)', async () => {
    const agent = await run({
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'in_progress' },
      ],
    })
    const result = lastResult(agent.session.events)
    expect(result.isError).toBe(false)
    expect(result.text).toBe(
      'Updated todo list: 0 pending, 2 in progress, 0 completed.',
    )
  })

  it('rejects several in_progress items under the single-active policy', async () => {
    const agent = await run(
      {
        todos: [
          { content: 'a', status: 'in_progress' },
          { content: 'b', status: 'in_progress' },
        ],
      },
      { allowParallelInProgress: false },
    )
    const result = lastResult(agent.session.events)
    expect(result.isError).toBe(true)
    expect(result.text).toBe(
      'Error: invalid todos: at most one task may be in_progress (got 2)',
    )
    expect(agent.session.events.some((e) => e.type === 'todo/write')).toBe(
      false,
    )
  })

  it('rejects an invalid status, blank content, and duplicates', async () => {
    let result = lastResult(
      (await run({ todos: [{ content: 'a', status: 'doing' }] })).session
        .events,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('invalid arguments for tool "todo_write"')
    result = lastResult(
      (await run({ todos: [{ content: '  ', status: 'pending' }] })).session
        .events,
    )
    expect(result.text).toBe(
      'Error: invalid todo: `content` must be a non-empty string',
    )
    result = lastResult(
      (
        await run({
          todos: [
            { content: 'a', status: 'pending' },
            { content: 'a ', status: 'completed' },
          ],
        })
      ).session.events,
    )
    expect(result.text).toBe('Error: invalid todos: duplicate content "a"')
  })

  it('currentTodos folds last-wins and clears at the next turn/start', async () => {
    const agent = await run({ todos: [{ content: 'a', status: 'pending' }] })
    expect(currentTodos(agent.session.events)).toEqual([
      { content: 'a', status: 'pending' },
    ])
    agent.session.append('turn/start', { turn: 99 })
    expect(currentTodos(agent.session.events)).toBeNull()
    expect(currentTodos([])).toBeNull()
  })
})
