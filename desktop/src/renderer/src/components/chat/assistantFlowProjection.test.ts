import { describe, expect, it } from 'vitest'
import type {
  AssistantMessage,
  AssistantSegment,
  ToolSegment,
} from '../../types'
import { projectAssistantFlow } from './assistantFlowProjection'

function message(
  segments: AssistantSegment[],
  streaming = false,
  todos: AssistantMessage['todos'] = null,
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    segments,
    todos,
    streaming,
    ...extra,
  }
}

function tool(
  id: string,
  name: string,
  status: ToolSegment['status'] = 'done',
  extra: Partial<ToolSegment> = {},
): ToolSegment {
  return {
    id,
    type: 'tool',
    toolId: id,
    name,
    status,
    displayName:
      name === 'read_file'
        ? 'Read'
        : name === 'run_command'
          ? 'Bash'
          : undefined,
    startedAt: extra.startedAt,
    endedAt: extra.endedAt,
    durationMs: extra.durationMs,
    ...extra,
  }
}

describe('assistant flow projection', () => {
  it('merges consecutive text segments into a prose block', () => {
    const blocks = projectAssistantFlow(
      message([
        { id: 't1', type: 'text', content: '第一段' },
        { id: 't2', type: 'text', content: '第二段' },
      ]),
    )

    expect(blocks).toEqual([
      {
        kind: 'text',
        id: 'text-t1-t2',
        content: '第一段\n\n第二段',
        streaming: false,
      },
    ])
  })

  it('marks only the final visible text block as streaming', () => {
    const blocks = projectAssistantFlow(
      message([{ id: 't1', type: 'text', content: '正在写' }], true),
    )

    expect(blocks[0]).toMatchObject({ kind: 'text', streaming: true })
  })

  it('groups tools from the same model batch into one execution node', () => {
    const blocks = projectAssistantFlow(
      message([
        tool('glob-1', 'glob', 'done', {
          batchId: 'batch-1',
          startedAt: 10,
          endedAt: 15,
        }),
        tool('glob-2', 'glob', 'done', {
          batchId: 'batch-1',
          startedAt: 12,
          endedAt: 22,
        }),
      ]),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'tool_group',
      id: 'tool-group-batch-1',
      title: '搜索代码 · 2 项',
      status: 'done',
      durationMs: 12,
      tools: expect.arrayContaining([
        expect.objectContaining({ toolId: 'glob-1' }),
        expect.objectContaining({ toolId: 'glob-2' }),
      ]),
    })
  })

  it('summarizes a batch of file mutations without rendering three full cards', () => {
    const blocks = projectAssistantFlow(
      message([
        tool('write-1', 'write_file', 'done', {
          batchId: 'batch-write',
          arguments: { path: 'src/App.vue' },
        }),
        tool('write-2', 'write_file', 'done', {
          batchId: 'batch-write',
          arguments: { path: 'src/main.ts' },
        }),
        tool('write-3', 'write_file', 'done', {
          batchId: 'batch-write',
          arguments: { path: 'README.md' },
        }),
      ]),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'tool_group',
      title: '修改 3 个文件',
    })
  })

  it('uses actual file targets in read and edit tool titles', () => {
    const blocks = projectAssistantFlow(
      message([
        tool('read-1', 'read_file', 'done', {
          batchId: 'batch-read',
          arguments: { path: 'agent/runner.py' },
        }),
        tool('edit-1', 'edit_file', 'done', {
          batchId: 'batch-edit',
          metadata: { path: 'desktop/src/renderer/src/App.vue' },
        }),
      ]),
    )

    expect(blocks).toHaveLength(2)
    expect(
      blocks.map((block) => (block.kind === 'tool_group' ? block.title : '')),
    ).toEqual(['Read · runner.py', 'Edit · App.vue'])
  })

  it('preserves each tool status on its own execution node', () => {
    const running = projectAssistantFlow(
      message([
        tool('bash-1', 'run_command', 'done'),
        tool('bash-2', 'run_command', 'running', { batchId: 'batch-2' }),
      ]),
    )
    const errored = projectAssistantFlow(
      message([
        tool('bash-1', 'run_command', 'running'),
        tool('bash-2', 'run_command', 'error', { batchId: 'batch-2' }),
      ]),
    )

    expect(
      running.map((block) => (block.kind === 'tool_group' ? block.status : '')),
    ).toEqual(['done', 'running'])
    expect(
      errored.map((block) => (block.kind === 'tool_group' ? block.status : '')),
    ).toEqual(['running', 'error'])
  })

  it('keeps ask and plan controls as independent blocks', () => {
    const blocks = projectAssistantFlow(
      message([
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
      ]),
    )

    expect(blocks.map((block) => block.kind)).toEqual(['control', 'control'])
  })

  it('filters short completed thoughts but keeps running thoughts', () => {
    const blocks = projectAssistantFlow(
      message([
        {
          id: 'thought-short',
          type: 'thought',
          status: 'done',
          durationMs: 80,
        },
        { id: 'thought-running', type: 'thought', status: 'running' },
      ]),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'thought', id: 'thought-running' })
  })

  it('keeps short completed audit thoughts when they include a summary', () => {
    const blocks = projectAssistantFlow(
      message([
        {
          id: 'thought-audit',
          type: 'thought',
          status: 'done',
          label: '思考参考',
          summary: '准备调用 read_file，先确认图片路径。',
          source: 'audit',
          stage: 'tool_intent',
          durationMs: 10,
        },
      ]),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'thought',
      id: 'thought-audit',
      segment: {
        summary: '准备调用 read_file，先确认图片路径。',
        stage: 'tool_intent',
      },
    })
  })

  it('filters legacy plain-success tool result summaries from the timeline', () => {
    const blocks = projectAssistantFlow(
      message([
        {
          id: 'thought-result',
          type: 'thought',
          status: 'done',
          label: '思考参考',
          stage: 'tool_result_summary',
          source: 'audit',
          summary: 'glob 成功：README.md AGENTS.md package.json',
          durationMs: 0,
        },
      ]),
    )

    expect(blocks).toHaveLength(0)
  })

  it('absorbs generated tool intent copy when the batch already explains the action', () => {
    const blocks = projectAssistantFlow(
      message([
        tool('read-1', 'read_file', 'done', { batchId: 'batch-read' }),
        {
          id: 'thought-intent',
          type: 'thought',
          status: 'done',
          label: '思考参考',
          stage: 'tool_intent',
          source: 'audit',
          summary: '准备调用 read_file，先收集上下文。',
          toolIds: ['read-1'],
          toolNames: ['read_file'],
        },
      ]),
    )

    expect(blocks.map((block) => block.kind)).toEqual(['tool_group'])
  })

  it('keeps notable tool result summaries for errors and media artifacts', () => {
    const blocks = projectAssistantFlow(
      message([
        {
          id: 'thought-result',
          type: 'thought',
          status: 'done',
          label: '思考参考',
          stage: 'tool_result_summary',
          source: 'audit',
          summary: 'read_file 失败；run_command 成功，识别到 1 个图片 artifact',
          durationMs: 0,
        },
      ]),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'thought', id: 'thought-result' })
  })

  it('uses assistant total duration for the first completed thought execution summary', () => {
    const blocks = projectAssistantFlow(
      message(
        [
          {
            id: 'thought-wait',
            type: 'thought',
            status: 'done',
            durationMs: 400,
          },
          tool('bash-1', 'run_command', 'done', { durationMs: 1200 }),
          {
            id: 'thought-followup',
            type: 'thought',
            status: 'done',
            durationMs: 300,
          },
        ],
        false,
        null,
        { startedAt: 1_000, endedAt: 6_000, durationMs: 5_000 },
      ),
    )

    expect(blocks[0]).toMatchObject({
      kind: 'thought',
      id: 'thought-wait',
      executionDurationMs: 5_000,
    })
    expect(blocks[2]).toMatchObject({
      kind: 'thought',
      id: 'thought-followup',
      executionDurationMs: undefined,
    })
  })

  it('derives execution duration from timed segments when message duration is missing', () => {
    const blocks = projectAssistantFlow(
      message([
        {
          id: 'thought-wait',
          type: 'thought',
          status: 'done',
          startedAt: 1_000,
          endedAt: 1_400,
          durationMs: 400,
        },
        tool('bash-1', 'run_command', 'done', {
          startedAt: 1_500,
          endedAt: 4_200,
          durationMs: 2_700,
        }),
        {
          id: 'thought-followup',
          type: 'thought',
          status: 'done',
          startedAt: 4_200,
          endedAt: 5_000,
          durationMs: 800,
        },
      ]),
    )

    expect(blocks[0]).toMatchObject({
      kind: 'thought',
      id: 'thought-wait',
      executionDurationMs: 4_000,
    })
  })

  it('uses total assistant elapsed time for the running execution summary', () => {
    const blocks = projectAssistantFlow(
      message(
        [
          {
            id: 'thought-wait',
            type: 'thought',
            status: 'running',
            startedAt: 1_000,
            durationMs: 300,
          },
        ],
        true,
        null,
        { startedAt: 1_000 },
      ),
      { now: 5_900 },
    )

    expect(blocks[0]).toMatchObject({
      kind: 'thought',
      id: 'thought-wait',
      executionDurationMs: 4_900,
    })
  })

  it('absorbs update_todos and omits a one-item checklist from the timeline', () => {
    const todos = [{ id: 1, content: '检查结果', status: 'pending' }]
    const blocks = projectAssistantFlow(
      message(
        [tool('todo-tool', 'update_todos', 'done', { todos })],
        false,
        todos,
      ),
    )

    expect(blocks).toEqual([])
  })

  it('shows only a complex independent checklist and never its update tool card', () => {
    const todos = [
      { id: 1, content: '检查入口', status: 'completed' },
      { id: 2, content: '修改实现', status: 'in_progress' },
      { id: 3, content: '完成验证', status: 'pending' },
    ]
    const blocks = projectAssistantFlow(
      message(
        [tool('todo-tool', 'update_todos', 'done', { todos })],
        false,
        todos,
      ),
    )

    expect(blocks).toEqual([{ kind: 'todos', id: 'todos-todo-tool', todos }])
  })

  it('suppresses legacy Plan-bound Todo mirrors', () => {
    const todos = [
      {
        id: 'plan:step_1',
        plan_step_id: 'step_1',
        content: '创建介绍页',
        status: 'in_progress',
      },
      {
        id: 'plan:step_2',
        plan_step_id: 'step_2',
        content: '验证介绍页',
        status: 'pending',
      },
      {
        id: 'plan:step_3',
        plan_step_id: 'step_3',
        content: '整理报告',
        status: 'pending',
      },
    ]

    expect(
      projectAssistantFlow(
        message(
          [tool('todo-tool', 'update_todos', 'done', { todos })],
          false,
          todos,
        ),
      ),
    ).toEqual([])
  })

  it('projects image media artifacts as an inline media block after the tool group', () => {
    const blocks = projectAssistantFlow(
      message([
        tool('bash-1', 'run_command', 'done', {
          artifacts: [
            {
              path: '/Users/me/Desktop/screen.png',
              kind: 'media',
              bytes: 512,
              media: {
                id: 'media_2026-06_abcdef12',
                kind: 'image',
                mime: 'image/png',
                name: 'screen.png',
                relPath: 'memory/media/2026-06/abcdef12-screen.png',
                originalPath: '/Users/me/Desktop/screen.png',
              },
            },
          ],
        }),
      ]),
    )

    expect(blocks.map((block) => block.kind)).toEqual(['tool_group', 'media'])
    expect(blocks[1]).toMatchObject({
      kind: 'media',
      id: 'media-bash-1',
      items: [
        {
          id: 'media_2026-06_abcdef12',
          kind: 'image',
          mime: 'image/png',
        },
      ],
    })
  })

  it('adds a fallback only for a complex independent checklist', () => {
    const todos = [{ id: 1, content: '检查结果', status: 'pending' }]
    const withoutToolTodos = projectAssistantFlow(
      message([{ id: 't1', type: 'text', content: '开始' }], false, todos),
    )
    const withToolTodos = projectAssistantFlow(
      message(
        [tool('todo-tool', 'update_todos', 'done', { todos })],
        false,
        todos,
      ),
    )

    expect(withoutToolTodos.map((block) => block.kind)).toEqual(['text'])
    expect(withToolTodos).toEqual([])
  })
})
