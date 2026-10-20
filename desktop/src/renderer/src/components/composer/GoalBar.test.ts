// @vitest-environment jsdom
// UI-S04: the goal dock keeps pause / resume and the two-step clear, and
// gains 编辑, which asks the owner to put `/goal edit <objective>` into the
// composer (Core edits the goal in place).
import { createApp, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeGoalView } from '../../types'
import GoalBar from './GoalBar.vue'

let app: App | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
})

function goal(phase: string): RuntimeGoalView {
  return {
    id: 'goal-1',
    revision: 1,
    objective: '让输入框更简单',
    phase,
    maxGoalRounds: 8,
    roundsStarted: 2,
    createdAt: Date.now() - 23_000,
    updatedAt: Date.now(),
  }
}

function mount(phase: string) {
  const onAction = vi.fn()
  const onEdit = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(GoalBar, { goal: goal(phase), onAction, onEdit })
  app.mount(host)
  const labels = () =>
    [...host!.querySelectorAll<HTMLButtonElement>('.actions button')].map(
      (button) => button.getAttribute('aria-label'),
    )
  const button = (label: string) =>
    host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  return { onAction, onEdit, labels, button }
}

describe('GoalBar', () => {
  it('offers pause, edit and clear for a running goal, in that order', async () => {
    const bar = mount('active')
    await nextTick()
    expect(bar.labels()).toEqual(['暂停 Goal', '编辑 Goal', '清除 Goal'])
    bar.button('编辑 Goal').click()
    expect(bar.onEdit).toHaveBeenCalledOnce()
    bar.button('暂停 Goal').click()
    expect(bar.onAction).toHaveBeenLastCalledWith('pause')
  })

  it('offers resume, edit and the two-step clear for a paused goal', async () => {
    const bar = mount('paused')
    await nextTick()
    expect(bar.labels()).toEqual(['恢复 Goal', '编辑 Goal', '清除 Goal'])
    bar.button('清除 Goal').click()
    await nextTick()
    expect(bar.onAction).not.toHaveBeenCalled()
    bar.button('确认清除 Goal').click()
    expect(bar.onAction).toHaveBeenLastCalledWith('cancel')
  })
})
