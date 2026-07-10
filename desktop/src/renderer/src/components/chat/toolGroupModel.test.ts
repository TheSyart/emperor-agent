import { describe, expect, it } from 'vitest'
import type { ToolSegment } from '../../types'
import { toolCardDefaultOpen, toolGroupDetailText } from './toolGroupModel'

function tool(name: string, status: ToolSegment['status'] = 'done', extra: Partial<ToolSegment> = {}): ToolSegment {
  return {
    id: `${name}-1`,
    type: 'tool',
    name,
    status,
    ...extra,
  }
}

describe('tool group model', () => {
  it('omits redundant completion detail for a single completed plain tool', () => {
    expect(toolGroupDetailText([tool('read_file')])).toBe('')
  })

  it('keeps completion detail for multi-tool groups', () => {
    expect(toolGroupDetailText([tool('glob'), tool('glob')])).toBe('已完成 2/2 个工具')
  })

  it('keeps active and todo detail for single tool groups when useful', () => {
    expect(toolGroupDetailText([tool('run_command', 'running')])).toBe('正在执行 Bash · 执行命令')
    expect(toolGroupDetailText([tool('update_todos', 'done', {
      todos: [
        { id: 1, content: '检查结果', status: 'completed' },
        { id: 2, content: '继续修复', status: 'pending' },
      ],
    })])).toBe('已更新 2 个任务步骤')
  })

  it('keeps every tool card collapsed until the user expands it', () => {
    expect(toolCardDefaultOpen([tool('run_command', 'running')])).toBe(false)
    expect(toolCardDefaultOpen([tool('update_todos', 'error')])).toBe(false)
    expect(toolCardDefaultOpen([tool('dispatch_subagent', 'done', {
      subagents: [{ id: 'agent-1', kind: 'subagent', role: 'worker', status: 'done', tools: [], messages: [] }],
    })])).toBe(false)
  })
})
