// @vitest-environment jsdom
// KRN-02: a prompt the agent did not run (the turn before it failed or was
// stopped, or the app restarted) stays in the queue as 「待发送」 with
// 发送 / 丢弃 actions.
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueuedPromptItem } from '../../types'
import QueueDock from './QueueDock.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

function item(overrides: Partial<QueuedPromptItem> = {}): QueuedPromptItem {
  return {
    id: 'p1',
    turnId: '',
    clientMessageId: 'c1',
    content: 'check the tests',
    delivery: 'queue',
    status: 'queued',
    supportsInterjection: true,
    createdOrder: 0,
    attachmentCount: 0,
    requestedSkillNames: [],
    hasCapabilityRefs: false,
    ...overrides,
  }
}

function mount(
  items: QueuedPromptItem[],
  handlers: Record<string, (item: QueuedPromptItem) => void> = {},
) {
  container = document.createElement('div')
  document.body.append(container)
  createApp(QueueDock, {
    items,
    onSend: handlers.send,
    onCancel: handlers.cancel,
    onInterject: handlers.interject,
    onEdit: handlers.edit,
  }).mount(container)
  return container
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

describe('QueueDock held prompts', () => {
  it.each([
    ['previous-turn-failed', '待发送 · 上一轮失败'],
    ['previous-turn-stopped', '待发送 · 上一轮已停止'],
    ['interrupted', '待发送 · 应用重启前未发出'],
  ] as const)('labels a prompt held for %s', async (holdReason, label) => {
    const root = mount([item({ status: 'failed-previous', holdReason })])
    await nextTick()
    expect(root.textContent).toContain(label)
    expect(root.textContent).toContain('1 条消息待发送')
  })

  it('offers 发送 and 丢弃 for a held prompt instead of 插入', async () => {
    const send = vi.fn()
    const cancel = vi.fn()
    const held = item({
      status: 'failed-previous',
      holdReason: 'previous-turn-failed',
    })
    const root = mount([held], { send, cancel })
    await nextTick()
    expect(root.querySelector('button[aria-label="插入当前执行"]')).toBeNull()
    button(root, '发送排队消息').click()
    button(root, '丢弃排队消息').click()
    expect(send).toHaveBeenCalledWith(held)
    expect(cancel).toHaveBeenCalledWith(held)
  })

  it('keeps 插入 and 删除 for an ordinary queued prompt', async () => {
    const root = mount([item()])
    await nextTick()
    expect(root.textContent).toContain('1 条消息排队中')
    expect(button(root, '插入当前执行')).toBeTruthy()
    expect(button(root, '删除排队消息')).toBeTruthy()
    expect(root.querySelector('button[aria-label="发送排队消息"]')).toBeNull()
  })
})
