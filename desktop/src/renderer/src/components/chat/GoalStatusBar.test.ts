// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeGoalSummary } from '../../types'
import GoalStatusBar from './GoalStatusBar.vue'

const source = readFileSync(join(__dirname, 'GoalStatusBar.vue'), 'utf8')

function goal(id = 'goal_1'): RuntimeGoalSummary {
  return {
    id,
    status: 'active',
    phase: 'executing',
    outcome: '完成 Composer 重构',
    sessionId: 'session_1',
    currentPlanId: null,
    cyclesUsed: 1,
    acceptance: { passed: 0, failed: 0, missing: 1, total: 1 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEventSeq: 2,
  }
}

describe('GoalStatusBar', () => {
  it('keeps Outcome editing local until confirmation and uses two-step cancellation', async () => {
    const model = ref(goal())
    const onEdit = vi.fn()
    const onAction = vi.fn()
    const Root = defineComponent(
      () => () =>
        h(GoalStatusBar, {
          goal: model.value,
          onEdit,
          onAction,
        }),
    )
    const container = document.createElement('div')
    document.body.append(container)
    const app = createApp(Root)
    app.mount(container)

    container
      .querySelector<HTMLButtonElement>('[aria-label="编辑 Goal Outcome"]')!
      .click()
    await nextTick()
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Goal Outcome"]',
    )!
    input.value = '替代后的 Outcome'
    input.dispatchEvent(new Event('input'))
    container
      .querySelector<HTMLButtonElement>('[aria-label="确认替换 Goal"]')!
      .click()
    expect(onEdit).toHaveBeenCalledWith('替代后的 Outcome')

    container
      .querySelector<HTMLButtonElement>('[aria-label="取消 Goal"]')!
      .click()
    await nextTick()
    expect(
      container.querySelector('[aria-label="确认取消 Goal"]'),
    ).not.toBeNull()
    expect(onAction).not.toHaveBeenCalledWith('cancel')
    container
      .querySelector<HTMLButtonElement>('[aria-label="确认取消 Goal"]')!
      .click()
    expect(onAction).toHaveBeenCalledWith('cancel')

    app.unmount()
    container.remove()
  })

  it('keeps the editor open and exposes replacement failures', () => {
    expect(source).toContain('replaceError')
    expect(source).toContain('goal-status-error')
    expect(source).toContain('watch(() => props.goal.id')
  })
})
