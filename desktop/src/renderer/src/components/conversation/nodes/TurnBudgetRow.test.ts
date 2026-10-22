// @vitest-environment jsdom
import { createApp, h, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  TurnBudgetChatData,
  TurnBudgetChatNode,
} from '../../../conversation/types'
import TurnBudgetRow from './TurnBudgetRow.vue'

// KRN-03: the user is told why the task budget ended a turn.

let app: App | null = null
let root: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  root?.remove()
  root = null
})

function render(reason: TurnBudgetChatData['reason']): string {
  root = document.createElement('div')
  document.body.append(root)
  const node = {
    key: 'turnBudget:1',
    kind: 'turnBudget',
    seq: 1,
    data: { turn: 1, seq: 1, time: 1, reason },
  } as unknown as TurnBudgetChatNode
  app = createApp({ render: () => h(TurnBudgetRow, { node }) })
  app.mount(root)
  return root.textContent ?? ''
}

describe('TurnBudgetRow', () => {
  it('says a turn reached its step limit, and where the limit is set', () => {
    const text = render({ kind: 'budget', limit: 'steps', maxSteps: 400 })
    expect(text).toContain('已达到单轮步数上限')
    expect(text).toContain('本轮已执行 400 步')
    expect(text).toContain('设置 › 高级 › 任务预算')
  })

  it('says the task spent its cost cap, subagents and failed attempts included', () => {
    const text = render({
      kind: 'budget',
      limit: 'cost',
      capUsdNanos: 1_000_000_000,
      spentUsdNanos: 1_200_000_000,
    })
    expect(text).toContain('已达到任务费用上限')
    expect(text).toContain('含子智能体与失败的请求')
    expect(text).toContain('$1.20')
    expect(text).toContain('$1.00')
  })

  it('names a route without a price, which is not counted', () => {
    const text = render({
      kind: 'budget',
      limit: 'cost',
      capUsdNanos: 1_000_000_000,
      spentUsdNanos: 1_100_000_000,
      unpricedRoutes: ['deepseek-flash'],
    })
    expect(text).toContain('$1.10')
    expect(text).toContain('模型 deepseek-flash 没有单价，未计入')
  })
})
