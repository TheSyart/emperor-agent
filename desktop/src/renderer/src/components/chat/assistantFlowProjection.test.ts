import { describe, expect, it } from 'vitest'
import type { AssistantMessage, AssistantSegment, ToolSegment } from '../../types'
import { projectAssistantFlow } from './assistantFlowProjection'

function message(segments: AssistantSegment[], streaming = false, todos = null): AssistantMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    segments,
    todos,
    streaming,
  }
}

function tool(id: string, name: string, status: ToolSegment['status'] = 'done', extra: Partial<ToolSegment> = {}): ToolSegment {
  return {
    id,
    type: 'tool',
    toolId: id,
    name,
    status,
    displayName: name === 'read_file' ? 'Read' : name === 'run_command' ? 'Bash' : undefined,
    startedAt: extra.startedAt,
    endedAt: extra.endedAt,
    durationMs: extra.durationMs,
    ...extra,
  }
}

describe('assistant flow projection', () => {
  it('merges consecutive text segments into a prose block', () => {
    const blocks = projectAssistantFlow(message([
      { id: 't1', type: 'text', content: '第一段' },
      { id: 't2', type: 'text', content: '第二段' },
    ]))

    expect(blocks).toEqual([
      { kind: 'text', id: 'text-t1-t2', content: '第一段\n\n第二段', streaming: false },
    ])
  })

  it('marks only the final visible text block as streaming', () => {
    const blocks = projectAssistantFlow(message([
      { id: 't1', type: 'text', content: '正在写' },
    ], true))

    expect(blocks[0]).toMatchObject({ kind: 'text', streaming: true })
  })

  it('merges consecutive tools and summarizes same tool kinds', () => {
    const blocks = projectAssistantFlow(message([
      tool('read-1', 'read_file', 'done', { durationMs: 5 }),
      tool('read-2', 'read_file', 'done', { durationMs: 7 }),
    ]))

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'tool_group',
      id: 'tool-group-read-1-read-2',
      title: 'Read × 2 · 读取文件',
      status: 'done',
      durationMs: 12,
    })
  })

  it('uses running status before done and error before running', () => {
    const running = projectAssistantFlow(message([
      tool('bash-1', 'run_command', 'done'),
      tool('bash-2', 'run_command', 'running'),
    ]))
    const errored = projectAssistantFlow(message([
      tool('bash-1', 'run_command', 'running'),
      tool('bash-2', 'run_command', 'error'),
    ]))

    expect(running[0]).toMatchObject({ kind: 'tool_group', status: 'running' })
    expect(errored[0]).toMatchObject({ kind: 'tool_group', status: 'error' })
  })

  it('keeps ask and plan controls as independent blocks', () => {
    const blocks = projectAssistantFlow(message([
      {
        id: 'ask-1',
        type: 'ask',
        interaction: { id: 'ask-1', kind: 'ask', status: 'waiting' },
      },
      {
        id: 'plan-1',
        type: 'plan',
        interaction: { id: 'plan-1', kind: 'plan', status: 'waiting' },
      },
    ]))

    expect(blocks.map((block) => block.kind)).toEqual(['control', 'control'])
  })

  it('filters short completed thoughts but keeps running thoughts', () => {
    const blocks = projectAssistantFlow(message([
      { id: 'thought-short', type: 'thought', status: 'done', durationMs: 80 },
      { id: 'thought-running', type: 'thought', status: 'running' },
    ]))

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'thought', id: 'thought-running' })
  })

  it('adds fallback todos only when no tool already carries todos', () => {
    const todos = [{ id: 1, content: '检查结果', status: 'pending' }]
    const withoutToolTodos = projectAssistantFlow(message([
      { id: 't1', type: 'text', content: '开始' },
    ], false, todos))
    const withToolTodos = projectAssistantFlow(message([
      tool('todo-tool', 'update_todos', 'done', { todos }),
    ], false, todos))

    expect(withoutToolTodos.at(-1)).toEqual({ kind: 'todos', id: 'todos-fallback', todos })
    expect(withToolTodos.some((block) => block.kind === 'todos')).toBe(false)
  })
})
