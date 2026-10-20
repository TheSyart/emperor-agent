import { describe, expect, it } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import { agentStack, agentSummary } from './environmentAgentsModel'

const agent = (
  id: string,
  phase: AgentView['phase'],
  updatedAt = 1,
): AgentView => ({
  id,
  parentAgentId: 'root',
  rootSessionId: 'root',
  backend: 'internal',
  kind: 'internal',
  title: id,
  phase,
  createdAt: 1,
  updatedAt,
})

describe('agentSummary (UI-S05 子智能体 row)', () => {
  it('counts phases in a fixed order and leaves zeros out', () => {
    expect(
      agentSummary([
        agent('a', 'completed'),
        agent('b', 'running'),
        agent('c', 'failed'),
        agent('d', 'completed'),
        agent('e', 'completed'),
      ]),
    ).toBe('1 运行 · 3 完成 · 1 失败')
  })

  it('names every phase briefly', () => {
    expect(
      agentSummary([
        agent('a', 'unknown'),
        agent('b', 'interrupted'),
        agent('c', 'waiting'),
        agent('d', 'running'),
      ]),
    ).toBe('1 运行 · 1 等待 · 1 中断 · 1 待确认')
  })

  it('reads 2 完成 for a finished pair and nothing for none', () => {
    expect(
      agentSummary([agent('a', 'completed'), agent('b', 'completed')]),
    ).toBe('2 完成')
    expect(agentSummary([])).toBe('')
  })
})

describe('agentStack', () => {
  it('stacks at most three faces, active ones first, then the latest', () => {
    const stack = agentStack([
      agent('old', 'completed', 1),
      agent('new', 'completed', 9),
      agent('live', 'running', 2),
      agent('mid', 'failed', 5),
    ])
    expect(stack.map((row) => row.id)).toEqual(['live', 'new', 'mid'])
  })

  it('keeps short lists whole', () => {
    expect(agentStack([agent('a', 'completed')])).toHaveLength(1)
    expect(agentStack([])).toEqual([])
  })
})
