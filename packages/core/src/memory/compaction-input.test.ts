import { describe, expect, it } from 'vitest'
import { CompactionInputProjector, renderProjectedConversation } from './compaction-input'

describe('CompactionInputProjector', () => {
  it('keeps user text head and tail when projecting long messages', () => {
    const text = `${'A'.repeat(3000)}${'B'.repeat(3000)}${'Z'.repeat(1200)}`
    const projector = new CompactionInputProjector()

    const [projected] = projector.project([{ seq: 7, role: 'user', content: text, turn_id: 'turn_1' }])

    expect(projected).toMatchObject({
      seq: 7,
      role: 'user',
      kind: 'user_text',
      turnId: 'turn_1',
      originalChars: text.length,
      truncated: true,
      durableHint: 'candidate',
      scopeHints: ['user_profile', 'global', 'episode'],
    })
    expect(projected!.content).toContain('A'.repeat(100))
    expect(projected!.content).toContain('[truncated middle, total 7200 chars]')
    expect(projected!.content).toContain('Z'.repeat(100))
    expect(projected!.projectedChars).toBeLessThan(text.length)
  })

  it('projects assistant tool calls with safe argument preview and stable hash', () => {
    const projector = new CompactionInputProjector()
    const [first] = projector.project([{
      seq: 3,
      role: 'assistant',
      content: '',
      turn_id: 'turn_1',
      tool_calls: [{
        id: 'call_1',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: '/tmp/demo.txt', api_key: 'sk-very-secret-token' }),
        },
      }],
    }])
    const [second] = projector.project([{
      seq: 3,
      role: 'assistant',
      content: '',
      turn_id: 'turn_1',
      tool_calls: [{
        id: 'call_1',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: '/tmp/demo.txt', api_key: 'sk-very-secret-token' }),
        },
      }],
    }])

    expect(first).toMatchObject({
      seq: 3,
      role: 'assistant',
      kind: 'assistant_tool_call',
      toolName: 'read_file',
      toolCallId: 'call_1',
      truncated: false,
      durableHint: 'likely_transient',
      scopeHints: ['project', 'discard'],
    })
    expect(first!.content).toContain('name=read_file')
    expect(first!.content).toContain('"api_key":"[REDACTED]"')
    expect(first!.contentHash).toBe(second!.contentHash)
  })

  it('projects tool results with metadata, truncation, and transient hint', () => {
    const projector = new CompactionInputProjector({ maxToolResultChars: 180 })
    const content = `summary line\n${'stderr: failure\n'.repeat(80)}`

    const [projected] = projector.project([{
      seq: 4,
      role: 'tool',
      name: 'run_command',
      tool_call_id: 'call_1',
      content,
      metadata: { exit_code: 1 },
      turn_id: 'turn_1',
    }])

    expect(projected).toMatchObject({
      kind: 'tool_result',
      role: 'tool',
      toolName: 'run_command',
      toolCallId: 'call_1',
      truncated: true,
      durableHint: 'likely_transient',
      scopeHints: ['project', 'discard'],
    })
    expect(projected!.content).toContain('exit=1')
    expect(projected!.content).toContain('chars=')
    expect(projected!.content).toContain('hash=sha256:')
    expect(projected!.content).toContain('[truncated tool result')
  })

  it('marks sensitive-looking user content as sensitive_candidate', () => {
    const projector = new CompactionInputProjector()

    const [projected] = projector.project([{ seq: 1, role: 'user', content: 'my api_key = abcdefghijklmnop', turn_id: 'turn_1' }])

    expect(projected!.durableHint).toBe('sensitive_candidate')
    expect(projected!.scopeHints).toEqual(['discard'])
  })

  it('does not project model_call or runtime_context audit rows into compaction model input', () => {
    const projector = new CompactionInputProjector()

    const projected = projector.project([
      { seq: 1, role: 'system', type: 'model_call', content: 'model call: input=100 output=20' },
      { seq: 2, role: 'system', type: 'runtime_context', content: '{"event":"tool_result"}' },
      { seq: 3, role: 'user', content: 'keep real user content', turn_id: 'turn_1' },
    ])

    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({ seq: 3, kind: 'user_text' })
  })
})

describe('renderProjectedConversation', () => {
  it('wraps projected input as untrusted old conversation data', () => {
    const projector = new CompactionInputProjector()
    const projected = projector.project([
      { seq: 1, role: 'user', content: 'remember I prefer concise replies', turn_id: 'turn_1' },
      { seq: 2, role: 'assistant', content: 'Noted.', turn_id: 'turn_1' },
    ])

    const rendered = renderProjectedConversation(projected)

    expect(rendered).toContain('<old_conversation_data>')
    expect(rendered).toContain('UNTRUSTED DATA')
    expect(rendered).toContain('[user_text seq=1')
    expect(rendered).toContain('[assistant_text seq=2')
    expect(rendered).toContain('</old_conversation_data>')
  })
})
