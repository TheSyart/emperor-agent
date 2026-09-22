import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ControlInteraction } from '../../types'
import {
  planDecisionVisible,
  planDisplayMarkdown,
  planStatusPresentation,
} from './planDisplay'

function interaction(
  extra: Partial<ControlInteraction> = {},
): ControlInteraction {
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

describe('plan display helpers', () => {
  it('keeps runtime progress and decisions out of the timeline plan view', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../conversation/tools/ExitPlanView.vue', import.meta.url),
      ),
      'utf8',
    )

    expect(source).not.toContain('<PlanReviewPanel')
    expect(source).not.toContain('plan-progress-strip')
    expect(source).not.toContain('plan-step-list')
    expect(source).not.toContain('Active Step')
    expect(source).not.toContain('Failed Verification')
  })

  it('presents provisional streamed plans as generating rather than awaiting approval', () => {
    expect(
      planStatusPresentation(interaction({ meta: { provisional: true } })),
    ).toEqual({
      label: '生成中',
      tone: 'running',
      risk: '中风险',
    })
  })

  it('keeps the proposal markdown static after runtime execution starts', () => {
    expect(planDisplayMarkdown(interaction())).toContain(
      '# AI 新闻日报 PPT 制作计划',
    )
  })

  it('keeps waiting plan decisions visible only while interaction is waiting', () => {
    expect(planDecisionVisible(interaction())).toBe(true)
    expect(
      planDecisionVisible(interaction({ meta: { provisional: true } })),
    ).toBe(false)
    expect(planDecisionVisible(interaction({ status: 'approved' }))).toBe(false)
  })

  it('keeps proposal status independent from runtime execution status', () => {
    expect(planStatusPresentation(interaction())).toEqual({
      label: '等待批准',
      tone: 'waiting',
      risk: '中风险',
    })
  })
})
