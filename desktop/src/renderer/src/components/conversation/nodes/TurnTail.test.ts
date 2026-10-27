// @vitest-environment jsdom
/**
 * GRP-05: in a single chat with a contact, a reply's footer has 👍 / 👎;
 * either opens one line for why, and 记下 hands the rating, the line and
 * the reply's id to the chat (which writes `contacts.feedback`). No buttons
 * in other chats, nor while the contact's personal memory is off (card
 * test: 反馈写入记忆).
 */
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnTailChatNode } from '../../../conversation/types'
import {
  createExpansionStore,
  provideChatContext,
  type ChatFeedback,
} from '../chatContext'
import TurnTail from './TurnTail.vue'

const node = {
  kind: 'turnTail',
  key: 'turnTail:1',
  turn: 1,
  anchorSeq: 9,
  data: {
    turn: 1,
    seq: 9,
    startedAt: 1_000,
    endedAt: 5_000,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    steps: 1,
    closingText: '先修溢出，再看暗色模式。',
    closingMessageId: 'msg-1-2',
  },
} as unknown as TurnTailChatNode

let app: App | null = null
let container: HTMLDivElement | null = null

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function mount(feedback?: ChatFeedback) {
  container = document.createElement('div')
  document.body.append(container)
  const Host = defineComponent({
    setup() {
      provideChatContext({
        actions: {
          inspect: () => undefined,
          openSubagent: () => undefined,
          editMessage: () => undefined,
        },
        expansion: createExpansionStore(),
        sessionId: () => 'chat-reviewer',
        ...(feedback ? { feedback } : {}),
      })
      return () => h(TurnTail, { node })
    },
  })
  app = createApp(Host)
  app.mount(container)
}

function button(name: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) =>
        item.getAttribute('aria-label') === name ||
        item.textContent?.trim() === name,
    ) ?? null
  )
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('feedback on a contact’s reply', () => {
  it('rates the reply with one line for why (card test: 反馈写入记忆)', async () => {
    const rated = new Map<number, 'up' | 'down'>()
    const submit = vi.fn(
      async (input: {
        turn: number
        rating: 'up' | 'down'
        note: string
        messageId?: string
      }) => {
        rated.set(input.turn, input.rating)
        return true
      },
    )
    mount({
      enabled: () => true,
      rated: (turn) => rated.get(turn) ?? null,
      submit,
    })
    await flush()
    expect(button('有帮助')).not.toBeNull()
    button('没帮助')!.click()
    await flush()
    const field = document.querySelector<HTMLInputElement>(
      '[data-feedback-form] input',
    )!
    expect(field).not.toBeNull()
    field.value = '先给结论'
    field.dispatchEvent(new Event('input'))
    await flush()
    button('记下')!.click()
    await flush()
    expect(submit).toHaveBeenCalledWith({
      turn: 1,
      rating: 'down',
      note: '先给结论',
      messageId: 'msg-1-2',
    })
    expect(document.querySelector('[data-feedback-form]')).toBeNull()
    expect(button('没帮助')!.getAttribute('aria-pressed')).toBe('true')
    expect(button('有帮助')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('has no buttons while the contact’s personal memory is off', async () => {
    mount({ enabled: () => false, rated: () => null, submit: vi.fn() })
    await flush()
    expect(button('有帮助')).toBeNull()
    expect(button('没帮助')).toBeNull()
    expect(button('复制')).not.toBeNull()
  })

  it('has no buttons outside a single chat with a contact', async () => {
    mount()
    await flush()
    expect(button('有帮助')).toBeNull()
    expect(button('复制')).not.toBeNull()
  })
})
