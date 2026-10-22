// @vitest-environment jsdom
// UI-S13: the line under a user message names a delivery only when it
// means something to the reader — 运行中插入 and 定时任务 — and never shows
// the raw source value (`chat`).
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import type { UserChatData, UserChatNode } from '../../../conversation/types'
import UserBubble from './UserBubble.vue'

let app: App | undefined
let element: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  element?.remove()
  app = undefined
  element = undefined
})

function node(patch: Partial<UserChatData>): UserChatNode {
  return {
    key: 'user:m1',
    kind: 'user',
    id: 'm1',
    target: 'chat',
    anchorSeq: 1,
    visibility: 'visible',
    turn: 1,
    step: null,
    data: {
      messageId: 'm1',
      seq: 1,
      time: 0,
      content: [{ type: 'text', text: '派遣子智能体查看项目' }],
      text: '派遣子智能体查看项目',
      attachments: [],
      steering: false,
      ...patch,
    },
  } as UserChatNode
}

async function sourceLine(
  patch: Partial<UserChatData>,
): Promise<string | null> {
  element = document.createElement('div')
  document.body.append(element)
  app = createApp({ render: () => h(UserBubble, { node: node(patch) }) })
  app.mount(element)
  await nextTick()
  return element.querySelector('.source')?.textContent?.trim() ?? null
}

describe('UserBubble source line (UI-S13)', () => {
  it('shows nothing for a plain prompt, whatever its raw source says', async () => {
    expect(await sourceLine({ source: 'chat' })).toBeNull()
    app?.unmount()
    element?.remove()
    expect(await sourceLine({})).toBeNull()
    app?.unmount()
    element?.remove()
    expect(await sourceLine({ source: 'api' })).toBeNull()
  })

  it('names a message inserted into a running turn', async () => {
    expect(await sourceLine({ source: 'chat', steering: true })).toBe(
      '运行中插入',
    )
  })

  it('names a message the scheduler sent', async () => {
    expect(await sourceLine({ source: 'scheduler' })).toBe('定时任务')
  })
})
