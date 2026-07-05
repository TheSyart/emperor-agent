import { describe, expect, it } from 'vitest'
import { compactReplayEvents } from '@emperor/core'
import { projectChatEvents } from './chatProjection'
import { projectAssistantFlow } from '../components/chat/assistantFlowProjection'
import type { AssistantMessage } from '../types'

describe('chatProjection', () => {
  it('rebuilds text, thought, tool, and control segments from runtime replay', () => {
    const state = projectChatEvents([
      { event: 'user_message', seq: 1, session_id: 's1', turn_id: 'turn_1', content: 'run tools' },
      { event: 'message_delta', seq: 2, session_id: 's1', turn_id: 'turn_1', delta: 'hello ' },
      { event: 'agent_thought', seq: 3, session_id: 's1', turn_id: 'turn_1', stage: 'tool_intent', label: '思考参考', summary: 'call read_file', source: 'audit', status: 'done', tool_call_ids: ['call_1'], tool_names: ['read_file'] },
      { event: 'tool_call', seq: 4, session_id: 's1', turn_id: 'turn_1', id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } },
      { event: 'tool_result', seq: 5, session_id: 's1', turn_id: 'turn_1', id: 'call_1', name: 'read_file', summary: 'ok' },
      { event: 'ask_request', seq: 6, session_id: 's1', turn_id: 'turn_1', interaction: { id: 'ask_1', kind: 'ask', status: 'waiting', context: 'scope?' } },
      { event: 'assistant_done', seq: 7, session_id: 's1', turn_id: 'turn_1', content: 'hello world' },
    ], { sessionId: 's1' })

    expect(state.lastSeq).toBe(7)
    expect(state.messages[0]).toMatchObject({ role: 'user', content: 'run tools', turn_id: 'turn_1' })
    const assistant = state.messages.find((message) => message.role === 'assistant')
    expect(assistant).toMatchObject({ role: 'assistant', content: 'hello world', streaming: false, turn_id: 'turn_1' })
    expect(assistant?.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', content: 'hello world' }),
      expect.objectContaining({ type: 'thought', status: 'done', stage: 'tool_intent', summary: 'call read_file' }),
      expect.objectContaining({ type: 'tool', name: 'read_file', status: 'done', summary: 'ok' }),
      expect.objectContaining({ type: 'ask', interaction: expect.objectContaining({ id: 'ask_1' }) }),
    ]))
  })

  it('deduplicates replay events by seq and ignores other sessions', () => {
    const state = projectChatEvents([
      { event: 'user_message', seq: 1, session_id: 's1', turn_id: 'turn_1', content: 'keep' },
      { event: 'user_message', seq: 1, session_id: 's1', turn_id: 'turn_1', content: 'keep duplicate' },
      { event: 'user_message', seq: 2, session_id: 's2', turn_id: 'turn_2', content: 'drop' },
      { event: 'tool_result', seq: 3, session_id: 's1', turn_id: 'turn_1', id: 'orphan', name: 'grep', summary: 'result first' },
      { event: 'assistant_done', seq: 4, session_id: 's1', turn_id: 'turn_1', content: 'done' },
    ], { sessionId: 's1' })

    expect(state.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(state.messages)).not.toContain('drop')
    const assistant = state.messages.find((message) => message.role === 'assistant')
    expect(assistant?.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', name: 'grep', status: 'done', summary: 'result first' }),
    ]))
  })

  it('replays new tool output and safely degrades legacy summary-only tool events', () => {
    const state = projectChatEvents([
      { event: 'user_message', seq: 1, session_id: 's1', turn_id: 'turn_1', content: 'tools' },
      { event: 'tool_call', seq: 2, session_id: 's1', turn_id: 'turn_1', id: 'call_new', name: 'run_command', arguments: { command: 'printf ok' } },
      { event: 'tool_result', seq: 3, session_id: 's1', turn_id: 'turn_1', id: 'call_new', name: 'run_command', summary: 'run_command exit 0', output: 'ok\n' },
      { event: 'tool_call', seq: 4, session_id: 's1', turn_id: 'turn_1', id: 'call_old', name: 'grep', arguments: { pattern: 'x' } },
      { event: 'tool_result', seq: 5, session_id: 's1', turn_id: 'turn_1', id: 'call_old', name: 'grep', summary: 'legacy grep summary' },
      { event: 'assistant_done', seq: 6, session_id: 's1', turn_id: 'turn_1', content: 'done' },
    ], { sessionId: 's1' })

    const assistant = state.messages.find((message) => message.role === 'assistant')
    const tools = assistant?.segments.filter((segment) => segment.type === 'tool') ?? []

    expect(tools.find((tool) => tool.toolId === 'call_new')).toMatchObject({
      summary: 'run_command exit 0',
      output: 'ok\n',
      outputMissing: false,
    })
    expect(tools.find((tool) => tool.toolId === 'call_old')).toMatchObject({
      summary: 'legacy grep summary',
      outputMissing: true,
    })
    expect(tools.find((tool) => tool.toolId === 'call_old')?.output).toBeUndefined()
  })

  // P1-3 fixture：按旧 session 96b48b39 的真实事件序列复刻（provisional delta 流、
  // propose_plan 被 cancel、plan_approved 无 turn_id、隐藏 control user_message 换 turn 续跑）。
  it('replays the full plan draft-delta/approve/resume sequence into one continuous assistant flow', () => {
    const provisional = (title: string) => ({
      id: 'provisional-plan-call_1',
      kind: 'plan',
      status: 'waiting',
      parent_call_id: 'call_1',
      title,
      summary: '',
      plan_markdown: '',
      meta: { plan_stream_id: 'call_1', provisional: true },
    })
    const state = projectChatEvents([
      { event: 'user_message', seq: 1, session_id: 's1', turn_id: 'turn_A', content: '随便做点东西' },
      { event: 'message_delta', seq: 2, session_id: 's1', turn_id: 'turn_A', delta: '先出个计划。' },
      { event: 'tool_run_queued', seq: 3, session_id: 's1', turn_id: 'turn_A', id: 'call_1', name: 'propose_plan', arguments: {} },
      { event: 'tool_run_started', seq: 4, session_id: 's1', turn_id: 'turn_A', id: 'call_1', name: 'propose_plan' },
      { event: 'tool_call', seq: 5, session_id: 's1', turn_id: 'turn_A', id: 'call_1', name: 'propose_plan', arguments: {} },
      { event: 'plan_draft_delta', seq: 6, session_id: 's1', turn_id: 'turn_A', interaction: provisional('Term') },
      { event: 'plan_draft_delta', seq: 7, session_id: 's1', turn_id: 'turn_A', interaction: provisional('Terminal Dream') },
      { event: 'plan_draft_delta', seq: 8, session_id: 's1', turn_id: 'turn_A', interaction: provisional('Terminal Dreamscape') },
      { event: 'tool_run_cancelled', seq: 9, session_id: 's1', turn_id: 'turn_A', id: 'call_1', name: 'propose_plan', reason: 'turn_paused' },
      { event: 'tool_result', seq: 10, session_id: 's1', turn_id: 'turn_A', id: 'call_1', name: 'propose_plan', summary: 'waiting for user (plan:plan_1)' },
      {
        event: 'plan_draft',
        seq: 11,
        session_id: 's1',
        turn_id: 'turn_A',
        interaction: {
          id: 'plan_1', kind: 'plan', status: 'waiting', parent_call_id: 'call_1',
          title: 'Terminal Dreamscape', plan_markdown: '# Plan', meta: { plan_id: 'plan_rec_1' },
        },
      },
      { event: 'turn_paused', seq: 12, session_id: 's1', turn_id: 'turn_A', interaction: { id: 'plan_1', kind: 'plan', status: 'waiting' } },
      { event: 'plan_approved', seq: 13, session_id: 's1', interaction: { id: 'plan_1', kind: 'plan', status: 'approved' } },
      { event: 'user_message', seq: 14, session_id: 's1', turn_id: 'turn_B', source: 'control', ui_hidden: true, content: '' },
      { event: 'message_delta', seq: 15, session_id: 's1', turn_id: 'turn_B', delta: '计划批准，开始执行。' },
      { event: 'tool_call', seq: 16, session_id: 's1', turn_id: 'turn_B', id: 'call_2', name: 'write_file', arguments: { path: 'main.py' } },
      { event: 'tool_result', seq: 17, session_id: 's1', turn_id: 'turn_B', id: 'call_2', name: 'write_file', summary: 'written' },
      { event: 'assistant_done', seq: 18, session_id: 's1', turn_id: 'turn_B', content: '先出个计划。计划批准，开始执行。' },
    ], { sessionId: 's1' })

    const assistants = state.messages.filter((message) => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    const assistant = assistants[0] as AssistantMessage
    expect(assistant.streaming).toBe(false)
    expect(state.messages.filter((message) => message.role === 'user')).toHaveLength(1)

    const planSegments = assistant.segments.filter((segment) => segment.type === 'plan')
    expect(planSegments).toHaveLength(1)
    expect(planSegments[0]!.interaction).toMatchObject({ id: 'plan_1', status: 'approved' })
    expect(planSegments[0]!.interaction.meta?.provisional).toBeUndefined()

    const proposeTool = assistant.segments.find((segment) => segment.type === 'tool' && segment.toolId === 'call_1')
    expect(proposeTool).toBeDefined()
    expect(proposeTool!.type === 'tool' && (proposeTool!.status === 'running' || proposeTool!.status === 'queued')).toBe(false)

    const blocks = projectAssistantFlow(assistant)
    const kinds = blocks.map((block) => block.kind)
    expect(kinds.filter((kind) => kind === 'control')).toHaveLength(1)
    for (const block of blocks) {
      if (block.kind === 'text') expect(block.content.trim()).not.toBe('')
    }
    const lastText = [...blocks].reverse().find((block) => block.kind === 'text')
    expect(lastText && lastText.kind === 'text' ? lastText.content : '').toContain('计划批准，开始执行。')
  })

  it('replays ask answer resume across turns into the same assistant', () => {
    const state = projectChatEvents([
      { event: 'user_message', seq: 1, session_id: 's1', turn_id: 'turn_A', content: '帮我改配置' },
      { event: 'message_delta', seq: 2, session_id: 's1', turn_id: 'turn_A', delta: '需要确认范围。' },
      { event: 'ask_request', seq: 3, session_id: 's1', turn_id: 'turn_A', interaction: { id: 'ask_1', kind: 'ask', status: 'waiting', context: '改哪个环境？' } },
      { event: 'turn_paused', seq: 4, session_id: 's1', turn_id: 'turn_A', interaction: { id: 'ask_1', kind: 'ask', status: 'waiting' } },
      { event: 'ask_answered', seq: 5, session_id: 's1', interaction: { id: 'ask_1', kind: 'ask', status: 'answered', answers: { q1: { choice: 'prod' } } } },
      { event: 'user_message', seq: 6, session_id: 's1', turn_id: 'turn_B', source: 'control', ui_hidden: true, content: '' },
      { event: 'message_delta', seq: 7, session_id: 's1', turn_id: 'turn_B', delta: '好，按 prod 处理。' },
      { event: 'assistant_done', seq: 8, session_id: 's1', turn_id: 'turn_B', content: '需要确认范围。好，按 prod 处理。' },
    ], { sessionId: 's1' })

    const assistants = state.messages.filter((message) => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    const askSegments = assistants[0]!.segments.filter((segment) => segment.type === 'ask')
    expect(askSegments).toHaveLength(1)
    expect(askSegments[0]!.interaction.status).toBe('answered')
    const blocks = projectAssistantFlow(assistants[0] as AssistantMessage)
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'control', 'text'])
  })

  // P1-5 golden：读取侧压缩后的回放流投影结果必须与原始流完全一致
  it('projects identical messages from a compacted replay stream (golden)', () => {
    const provisional = (title: string, seq: number) => ({
      event: 'plan_draft_delta' as const,
      seq,
      session_id: 's1',
      turn_id: 'turn_A',
      tool_call_id: 'call_1',
      interaction: {
        id: 'provisional-plan-call_1', kind: 'plan', status: 'waiting', parent_call_id: 'call_1',
        title, meta: { plan_stream_id: 'call_1', provisional: true },
      },
    })
    const full = [
      { event: 'user_message', seq: 1, session_id: 's1', turn_id: 'turn_A', content: '开工' },
      { event: 'message_delta', seq: 2, session_id: 's1', turn_id: 'turn_A', delta: '先' },
      { event: 'message_delta', seq: 3, session_id: 's1', turn_id: 'turn_A', delta: '规划' },
      { event: 'message_delta', seq: 4, session_id: 's1', turn_id: 'turn_A', delta: '。' },
      { event: 'tool_call', seq: 5, session_id: 's1', turn_id: 'turn_A', id: 'call_0', name: 'read_file', arguments: { path: 'a' } },
      { event: 'tool_result', seq: 6, session_id: 's1', turn_id: 'turn_A', id: 'call_0', name: 'read_file', summary: 'ok' },
      { event: 'message_delta', seq: 7, session_id: 's1', turn_id: 'turn_A', delta: '看完了' },
      ...Array.from({ length: 30 }, (_, index) => provisional('T'.repeat(index + 1), 8 + index)),
      {
        event: 'plan_draft', seq: 40, session_id: 's1', turn_id: 'turn_A',
        interaction: { id: 'plan_1', kind: 'plan', status: 'waiting', parent_call_id: 'call_1', title: 'T'.repeat(30), plan_markdown: '# P' },
      },
      { event: 'assistant_done', seq: 41, session_id: 's1', turn_id: 'turn_A', content: '先规划。看完了' },
    ]

    const compacted = compactReplayEvents(full as Array<Record<string, unknown>>)
    expect(compacted.length).toBeLessThan(full.length)
    expect(compacted.filter((event) => event.event === 'plan_draft_delta')).toHaveLength(1)
    expect(compacted.filter((event) => event.event === 'message_delta')).toHaveLength(2)

    const fromFull = projectChatEvents(full as never, { sessionId: 's1' })
    const fromCompacted = projectChatEvents(compacted as never, { sessionId: 's1' })
    expect(fromCompacted.messages).toEqual(fromFull.messages)
  })

  it('keeps a plan approval resume turn inside the paused assistant flow during replay', () => {
    const state = projectChatEvents([
      { event: 'user_message', seq: 1, session_id: 's1', turn_id: 'turn_plan', content: 'make a plan' },
      { event: 'message_delta', seq: 2, session_id: 's1', turn_id: 'turn_plan', delta: 'drafting ' },
      {
        event: 'plan_draft',
        seq: 3,
        session_id: 's1',
        turn_id: 'turn_plan',
        interaction: { id: 'plan_1', kind: 'plan', status: 'waiting', title: 'Plan', plan_markdown: '# Plan' },
      },
      { event: 'turn_paused', seq: 4, session_id: 's1', turn_id: 'turn_plan', interaction: { id: 'plan_1', kind: 'plan', status: 'waiting' } },
      { event: 'plan_approved', seq: 5, session_id: 's1', interaction: { id: 'plan_1', kind: 'plan', status: 'approved' } },
      { event: 'user_message', seq: 6, session_id: 's1', turn_id: 'turn_resume', source: 'control', ui_hidden: true, content: '' },
      { event: 'message_delta', seq: 7, session_id: 's1', turn_id: 'turn_resume', delta: 'executing' },
      { event: 'assistant_done', seq: 8, session_id: 's1', turn_id: 'turn_resume', content: 'drafting executing' },
    ], { sessionId: 's1' })

    const assistants = state.messages.filter((message) => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ content: 'drafting executing', streaming: false })
    expect(assistants[0]?.segments).toEqual([
      expect.objectContaining({ type: 'text', content: 'drafting ' }),
      expect.objectContaining({ type: 'plan', interaction: expect.objectContaining({ id: 'plan_1', status: 'approved' }) }),
      expect.objectContaining({ type: 'text', content: 'executing' }),
    ])
  })
})

describe('safety refusal labeling (2026-07-05 B4.3)', () => {
  it('labels safety-refusal tool failures as blocked instead of generic failure', async () => {
    const { projectChatEvents } = await import('./chatProjection')
    const projection = projectChatEvents([
      { event: 'user_message', seq: 1, turn_id: 't1', content: 'run' },
      { event: 'tool_call', seq: 2, turn_id: 't1', id: 'c1', name: 'run_command', arguments: { command: 'node -e "x"' } },
      { event: 'tool_run_failed', seq: 3, turn_id: 't1', id: 'c1', name: 'run_command', message: 'Error: command refused by safety policy (matches dangerous pattern: /x/)', reason_kind: 'safety_refusal' },
      { event: 'assistant_done', seq: 4, turn_id: 't1', content: 'done' },
    ] as never)
    const assistant = projection.messages.find((message) => message.role === 'assistant')!
    const tool = assistant.segments.find((segment) => segment.type === 'tool') as { status: string; summary?: string }
    expect(tool.status).toBe('error')
    expect(String(tool.summary || '')).toContain('被安全策略拦截')
  })
})
