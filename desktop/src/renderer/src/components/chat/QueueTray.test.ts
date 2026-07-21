// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueuedPromptItem } from '../../types'
import QueueTray from './QueueTray.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

function queued(id: string, content: string, createdOrder: number) {
  return {
    id,
    turnId: `turn-${id}`,
    clientMessageId: `client-${id}`,
    content,
    delivery: 'queue',
    status: 'queued',
    supportsInterjection: true,
    createdOrder,
    attachmentCount: 0,
    requestedSkillNames: [],
    hasCapabilityRefs: false,
  } satisfies QueuedPromptItem
}

describe('QueueTray single-slot projection', () => {
  it('shows only the FIFO head and reports legacy overflow without discarding it', () => {
    container = document.createElement('div')
    document.body.append(container)
    createApp(QueueTray, {
      items: [queued('second', '第二条旧消息', 20), queued('first', '第一条消息', 10)],
    }).mount(container)

    expect(container.querySelectorAll('.queue-item')).toHaveLength(1)
    expect(container.textContent).toContain('第一条消息')
    expect(container.textContent).not.toContain('第二条旧消息')
    expect(container.textContent).toContain('另有 1 条旧队列')
  })

  it('exposes direct interject/delete actions and an accessible edit menu', async () => {
    const item = queued('first', '插入这条', 10)
    const onEdit = vi.fn()
    const onInterject = vi.fn()
    const onCancel = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    createApp(QueueTray, {
      items: [item],
      onEdit,
      onInterject,
      onCancel,
    }).mount(container)

    const interject = container.querySelector<HTMLButtonElement>(
      '[aria-label="插入当前执行"]',
    )!
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="删除排队消息"]',
    )!
    const menu = container.querySelector<HTMLButtonElement>(
      '[aria-label="更多队列操作"]',
    )!

    expect(menu.getAttribute('aria-haspopup')).toBe('menu')
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    interject.click()
    remove.click()
    menu.click()
    await nextTick()
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()

    expect(onInterject).toHaveBeenCalledWith(item)
    expect(onCancel).toHaveBeenCalledWith(item)
    expect(onEdit).toHaveBeenCalledWith(item)
  })
})
