import { describe, expect, it } from 'vitest'
import type { ToolSegment } from '../../types'
import {
  toolBatchTitle,
  toolCardDefaultOpen,
  toolGroupDetailText,
} from './toolGroupModel'

function tool(
  name: string,
  status: ToolSegment['status'] = 'done',
  extra: Partial<ToolSegment> = {},
): ToolSegment {
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
    expect(toolGroupDetailText([tool('glob'), tool('glob')])).toBe(
      '已完成 2/2 个工具',
    )
  })

  it('keeps active and todo detail for single tool groups when useful', () => {
    expect(toolGroupDetailText([tool('run_command', 'running')])).toBe(
      '正在执行 Bash · 执行命令',
    )
    expect(
      toolGroupDetailText([
        tool('update_todos', 'done', {
          todos: [
            { id: 1, content: '检查结果', status: 'completed' },
            { id: 2, content: '继续修复', status: 'pending' },
          ],
        }),
      ]),
    ).toBe('已更新 2 个任务步骤')
  })

  it('keeps successful batches collapsed and opens failed batches', () => {
    expect(toolCardDefaultOpen([tool('run_command', 'running')])).toBe(false)
    expect(toolCardDefaultOpen([tool('update_todos', 'error')])).toBe(true)
    expect(
      toolCardDefaultOpen([
        tool('dispatch_subagent', 'done', {
          subagents: [
            {
              id: 'agent-1',
              kind: 'subagent',
              role: 'worker',
              status: 'done',
              tools: [],
              messages: [],
            },
          ],
        }),
      ]),
    ).toBe(false)
  })

  it('builds concise Codex-style batch titles', () => {
    expect(toolBatchTitle([tool('read_file'), tool('run_command')])).toBe(
      '读取文件、运行命令',
    )
    expect(
      toolBatchTitle([
        tool('write_file'),
        tool('edit_file'),
        tool('delete_file'),
      ]),
    ).toBe('修改 3 个文件')
    expect(toolBatchTitle([tool('grep'), tool('glob')])).toBe('搜索代码 · 2 项')
  })

  it('renders an independent reviewer as one compact verification node', () => {
    const reviewer = tool('dispatch_subagent', 'done', {
      arguments: { agent_type: 'verification_reviewer' },
      output:
        '```verdict\n{"passed":true,"commands":["npm test"],"command_evidence":[{"command":"npm test","exit_code":0}]}\n```',
    })
    expect(toolBatchTitle([reviewer])).toBe('独立复核')
    expect(toolGroupDetailText([reviewer])).toBe('复核通过')
  })
})
