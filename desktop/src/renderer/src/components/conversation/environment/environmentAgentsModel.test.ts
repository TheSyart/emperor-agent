import { describe, expect, it } from 'vitest'
import type { AgentView } from '@emperor/core/api'
import {
  agentDuration,
  agentStack,
  agentSummary,
} from './environmentAgentsModel'

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
        agent('b', 'failed'),
        agent('c', 'interrupted'),
        agent('d', 'completed'),
        agent('e', 'completed'),
      ]),
    ).toBe('3 完成 · 1 失败 · 1 中断')
  })

  it('leaves 完成 out while any subagent runs or waits (UI-S14)', () => {
    const done = [agent('a', 'completed'), agent('b', 'completed')]
    expect(
      agentSummary([
        ...done,
        agent('c', 'running'),
        agent('d', 'failed'),
        agent('e', 'unknown'),
      ]),
    ).toBe('1 运行 · 1 失败 · 1 待确认')
    expect(agentSummary([...done, agent('c', 'waiting')])).toBe('1 等待')
    // Once none is active the finished ones count again.
    expect(agentSummary([...done, agent('d', 'failed')])).toBe(
      '2 完成 · 1 失败',
    )
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

describe('agentDuration (AGT-10)', () => {
  const at = (
    phase: AgentView['phase'],
    createdAt: number,
    updatedAt: number,
  ) => ({ phase, createdAt, updatedAt }) as AgentView
  it('8 · says how long a finished agent took and how long a running one has run', () => {
    expect(agentDuration(at('completed', 0, 42_000), 999_999)).toBe(
      '用时 42 秒',
    )
    expect(agentDuration(at('failed', 0, 5 * 60_000 + 10_000), 0)).toBe(
      '用时 5 分钟',
    )
    expect(agentDuration(at('running', 0, 1000), 90 * 60_000)).toBe(
      '已运行 1 小时 30 分',
    )
    expect(agentDuration(at('waiting', 0, 1000), 400)).toBe('已运行 不到 1 秒')
    expect(agentDuration(at('completed', 0, 2 * 3_600_000), 0)).toBe(
      '用时 2 小时',
    )
  })
  it('says nothing for an agent with no trustworthy times', () => {
    expect(agentDuration(at('unknown', 0, 0), 1000)).toBe('')
    expect(agentDuration(at('completed', 5000, 1000), 9000)).toBe('')
  })
})
