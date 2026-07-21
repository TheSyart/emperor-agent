// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Composer from './Composer.vue'

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

describe('Composer single queue slot', () => {
  it('keeps the draft and reports an error when Enter is pressed with an occupied queue', async () => {
    const onSend = vi.fn()
    const onError = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    createApp(Composer, {
      busy: true,
      queueOccupied: true,
      commands: [],
      tools: [],
      contextUsed: 0,
      contextMax: 0,
      modelEntries: [],
      providerOptions: [],
      onSend,
      onError,
    }).mount(container)

    const textarea = container.querySelector('textarea')!
    textarea.value = 'second queued message'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await nextTick()

    expect(onSend).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      '已有一条消息排队，请先编辑、插入或删除后再发送。',
    )
    expect(textarea.value).toBe('second queued message')
  })

  it('restores text, capability display content and attachments after a Core race rejection', async () => {
    container = document.createElement('div')
    document.body.append(container)
    const component = createApp(Composer, {
      busy: true,
      queueOccupied: true,
      commands: [],
      tools: [],
      contextUsed: 0,
      contextMax: 0,
      modelEntries: [],
      providerOptions: [],
    }).mount(container) as unknown as {
      restoreDraft: (payload: Record<string, unknown>) => void
    }

    component.restoreDraft({
      content: '继续处理',
      displayContent: '继续处理 /skill:reviewer',
      attachments: [
        {
          id: 'att_restore',
          name: 'evidence.md',
          mime: 'text/markdown',
          size: 42,
          kind: 'text',
          hasText: true,
          hasImage: false,
          path: '/private/attachment/evidence.md',
        },
      ],
    })
    await nextTick()

    expect(
      container.querySelector<HTMLTextAreaElement>('textarea')?.value,
    ).toBe('继续处理 /skill:reviewer')
    expect(container.textContent).toContain('evidence.md')
  })
})
