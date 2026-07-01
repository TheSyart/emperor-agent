import { describe, expect, it } from 'vitest'
import type { ControlInteraction, RuntimePlanRecord } from '../../types'
import {
  planDecisionVisible,
  planDisplayMarkdown,
  planProgressSummary,
  planStatusPresentation,
} from './planDisplay'

function interaction(extra: Partial<ControlInteraction> = {}): ControlInteraction {
  return {
    id: 'plan-1',
    kind: 'plan',
    status: 'waiting',
    title: 'AI 新闻日报 PPT 制作计划',
    summary: '制作一份 PPTX',
    plan_markdown: '# AI 新闻日报 PPT 制作计划\n\n## Summary\n- 输出 PPTX',
    risk_level: 'medium',
    ...extra,
  }
}

function plan(extra: Partial<RuntimePlanRecord> = {}): RuntimePlanRecord {
  return {
    id: 'plan-record-1',
    title: 'AI 新闻日报 PPT 制作计划',
    status: 'executing',
    summary: '正在执行',
    steps: [
      { id: 's1', title: '收集上下文', status: 'done' },
      { id: 's2', title: '生成 PPT', status: 'active' },
      { id: 's3', title: '验证', status: 'pending' },
    ],
    plan_markdown: '# Runtime Plan\n\n## Summary\n- runtime markdown',
    ...extra,
  }
}

describe('plan display helpers', () => {
  it('uses runtime plan markdown before stale interaction markdown', () => {
    expect(planDisplayMarkdown(interaction(), plan())).toContain('# Runtime Plan')
  })

  it('keeps waiting plan decisions visible only while interaction is waiting', () => {
    expect(planDecisionVisible(interaction())).toBe(true)
    expect(planDecisionVisible(interaction({ status: 'approved' }))).toBe(false)
  })

  it('summarizes plan status and progress for the large timeline card', () => {
    expect(planStatusPresentation(interaction(), plan())).toEqual({
      label: '执行中',
      tone: 'running',
      risk: '中风险',
    })
    expect(planProgressSummary(plan())).toEqual({
      total: 3,
      done: 1,
      active: 1,
      failed: 0,
      label: '1/3 完成 · 1 执行中',
    })
  })
})
