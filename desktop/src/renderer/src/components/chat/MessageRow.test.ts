// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, UserMessage } from '../../types'
import MessageRow from './MessageRow.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

describe('MessageRow prompt delivery state', () => {
  it.each([
    ['queued', '已排队'],
    ['running', '处理中'],
    ['interjected', '已插话'],
    ['cancelled', '已取消'],
  ] as const)('renders %s as %s', (deliveryState, label) => {
    container = document.createElement('div')
    document.body.append(container)
    const message: UserMessage = {
      id: `user-${deliveryState}`,
      role: 'user',
      content: 'new instruction',
      deliveryState,
      deliveryReason:
        deliveryState === 'cancelled' ? 'owner turn cancelled' : undefined,
    }
    const app = createApp(() => h(MessageRow, { message, plans: [] }))
    app.mount(container)

    const badge = container.querySelector<HTMLElement>('.prompt-delivery-state')
    expect(badge?.textContent).toContain(label)
    if (deliveryState === 'cancelled')
      expect(badge?.title).toBe('owner turn cancelled')

    app.unmount()
  })

  it('marks a tombstoned assistant partial as replaced', () => {
    container = document.createElement('div')
    document.body.append(container)
    const message: AssistantMessage = {
      id: 'assistant-obsolete',
      role: 'assistant',
      content: 'obsolete partial',
      segments: [
        { id: 'text-obsolete', type: 'text', content: 'obsolete partial' },
      ],
      streaming: false,
      tombstoned: true,
      terminalReason: 'interjected',
    }
    const app = createApp(() => h(MessageRow, { message, plans: [] }))
    app.mount(container)

    expect(
      container.querySelector('.assistant-terminal-state')?.textContent,
    ).toContain('已被插话替代')

    app.unmount()
  })

  it('exposes a continue action for an evaluated pause card', () => {
    container = document.createElement('div')
    document.body.append(container)
    const onContinueExecution = vi.fn()
    const message: AssistantMessage = {
      id: 'assistant-paused',
      role: 'assistant',
      content: '',
      segments: [
        {
          id: 'continuation-pause',
          type: 'plan_activity',
          label: '执行已暂停',
          detail: '重复读取，没有形成新进展。',
          tone: 'error',
          action: 'continue',
          nextActions: ['检查阻塞原因'],
        },
      ],
      streaming: false,
    }
    const app = createApp(() =>
      h(MessageRow, {
        message,
        plans: [],
        onContinueExecution,
      }),
    )
    app.mount(container)

    const button = container.querySelector<HTMLButtonElement>(
      '.plan-activity-continue',
    )!
    expect(button.textContent).toContain('继续执行')
    button.click()
    expect(onContinueExecution).toHaveBeenCalledTimes(1)

    app.unmount()
  })
})
