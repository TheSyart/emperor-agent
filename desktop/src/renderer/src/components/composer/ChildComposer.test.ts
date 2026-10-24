// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import ChildComposer from './ChildComposer.vue'

let app: App | undefined
let root: HTMLDivElement
const handlers = {
  send: vi.fn(),
  stop: vi.fn(),
}

async function mount(props: Record<string, unknown> = {}) {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(ChildComposer, {
        ...props,
        onSend: handlers.send,
        onStop: handlers.stop,
      }),
  })
  app.mount(root)
  await nextTick()
}
const input = () => root.querySelector<HTMLTextAreaElement>('textarea')!
async function type(text: string) {
  input().value = text
  input().dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
function press(init: KeyboardEventInit) {
  input().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }),
  )
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  vi.clearAllMocks()
})

it('6 · Enter sends the trimmed message to the child; Shift+Enter and an IME do not', async () => {
  await mount()
  expect(input().getAttribute('placeholder')).toBe('给子智能体发消息')
  await type('  再跑一遍测试  ')
  press({ shiftKey: true })
  press({ isComposing: true })
  expect(handlers.send).not.toHaveBeenCalled()
  press({})
  expect(handlers.send).toHaveBeenCalledWith('再跑一遍测试')
  root.querySelector<HTMLButtonElement>('[data-child-send]')!.click()
  expect(handlers.send).toHaveBeenCalledTimes(2)
})

it('does not send an empty draft, while sending, or once the child took no more messages', async () => {
  await mount({ closed: '这个子智能体已经结束，不能再发消息。' })
  await type('hi')
  press({})
  expect(handlers.send).not.toHaveBeenCalled()
  expect(root.textContent).toContain('已经结束')
  expect(input().disabled).toBe(true)
  app!.unmount()
  root.remove()
  await mount({ sending: true })
  await type('hi')
  press({})
  expect(handlers.send).not.toHaveBeenCalled()
  app!.unmount()
  root.remove()
  await mount()
  await type('   ')
  expect(
    root.querySelector<HTMLButtonElement>('[data-child-send]')!.disabled,
  ).toBe(true)
})

it('says when a running child reads the message, and offers 停止', async () => {
  await mount({ running: true, steer: true })
  expect(root.textContent).toContain('消息会直接插进去')
  root.querySelector<HTMLButtonElement>('[data-stop-child]')!.click()
  expect(handlers.stop).toHaveBeenCalledTimes(1)
  app!.unmount()
  root.remove()
  await mount({ running: true })
  expect(root.textContent).toContain('这一轮结束后送达')
  app!.unmount()
  root.remove()
  await mount()
  expect(root.querySelector('[data-stop-child]')).toBeNull()
  expect(root.textContent).toContain('下一轮读到')
})

it('names the parent and shows a failed send; the way back is the page header (BUG-03)', async () => {
  await mount({
    parentTitle: '调研子任务',
    error: '这个子智能体已经结束，不能再发消息。',
  })
  expect(root.textContent).toContain('父智能体：调研子任务')
  expect(root.querySelector('[data-child-send-error]')!.textContent).toContain(
    '已经结束',
  )
  expect(root.querySelector('[data-child-back]')).toBeNull()
  expect(root.querySelector('[data-child-root]')).toBeNull()
  expect(root.textContent).not.toContain('返回父智能体')
  expect(root.textContent).not.toContain('返回主会话')
})
