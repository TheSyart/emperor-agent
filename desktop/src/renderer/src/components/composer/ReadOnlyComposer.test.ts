// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { expect, it } from 'vitest'
import ReadOnlyComposer from './ReadOnlyComposer.vue'
it('keeps parent navigation separate from root continuation and never exposes a send input', () => {
  const root = document.createElement('div')
  let parent = 0,
    continuation = 0,
    stopped = 0
  const app = createApp({
    render: () =>
      h(ReadOnlyComposer, {
        parentTitle: 'creation task',
        running: true,
        onBack: () => parent++,
        onRoot: () => continuation++,
        onStop: () => stopped++,
      }),
  })
  app.mount(root)
  try {
    const buttons = [...root.querySelectorAll('button')]
    buttons
      .find((button) => button.textContent?.includes('返回主会话'))!
      .click()
    expect(continuation).toBe(1)
    expect(parent).toBe(0)
    expect(stopped).toBe(0)
    buttons
      .find((button) => button.textContent?.includes('返回父智能体'))!
      .click()
    expect(parent).toBe(1)
    expect(root.querySelector('textarea,input')).toBeNull()
    expect(root.textContent).toContain('子智能体对话 · 只读')
  } finally {
    app.unmount()
  }
})
