// @vitest-environment jsdom
/** BUG-07: an inserted message shows at once, marked as waiting for the step. */
import { afterEach, expect, it } from 'vitest'
import { createApp, h, type Component } from 'vue'
import ProvisionalUserBubble from './ProvisionalUserBubble.vue'

let root: HTMLDivElement | null = null
afterEach(() => {
  root?.remove()
  root = null
})

it('shows the inserted text with 「等这一步结束后加入」 and no message actions', () => {
  root = document.createElement('div')
  document.body.append(root)
  createApp({
    render: () =>
      h(ProvisionalUserBubble as Component, {
        prompt: {
          id: 'p1',
          clientMessageId: 'p1',
          content: '只统计 src 目录',
          createdOrder: 1,
          sessionId: 's1',
        },
      }),
  }).mount(root)
  expect(root.querySelector('.user-bubble')?.textContent).toContain(
    '只统计 src 目录',
  )
  expect(root.querySelector('[role="status"]')?.textContent).toContain(
    '等这一步结束后加入',
  )
  expect(root.querySelector('button')).toBeNull()
})
