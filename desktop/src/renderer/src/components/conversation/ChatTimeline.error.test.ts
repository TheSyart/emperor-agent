// @vitest-environment jsdom
/**
 * FIX-03 (UI-11, UI-12): a history read that fails shows its error with
 * 「重试」 in the timeline, and retrying loads the conversation; while a
 * read is under way the timeline shows its skeleton.
 */
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import ChatTimeline from './ChatTimeline.vue'
import { ConversationStore } from '../../conversation/store'
import { FakeHistoryApi, LogBuilder } from '../../conversation/testing/fixtures'

globalThis.IntersectionObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
} as unknown as typeof IntersectionObserver

let app: ReturnType<typeof createApp> | null = null
let container: HTMLDivElement | null = null
afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

async function settle(rounds = 30): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await Promise.resolve()
    await nextTick()
  }
}

function conversation(): LogBuilder {
  const log = new LogBuilder()
  log.add('turn/start', { turn: 1 })
  log.user('u1', '帮我看看这个文件')
  log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return log
}

function mount(store: ConversationStore): HTMLElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    render: () => h(ChatTimeline, { sessionId: 's1', store }),
  })
  app.use(
    createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { render: () => null } }],
    }),
  )
  app.mount(container)
  return container
}

const immediate = {
  frame: (callback: () => void) => callback(),
  microtask: (callback: () => void) => callback(),
}

describe('ChatTimeline history states (FIX-03)', () => {
  it('4 · shows a failed read with 重试, and 重试 loads the conversation', async () => {
    const api = new FakeHistoryApi([...conversation().events])
    api.failNext = new Error('读取超时')
    const store = new ConversationStore({
      api: { history: (query) => api.history(query) },
      watch: vi.fn(async () => undefined),
      subscribe: () => () => undefined,
      scheduler: immediate,
    })
    const root = mount(store)
    await settle()
    const alert = root.querySelector('.open-error')!
    expect(alert.textContent).toContain('读取超时')
    const retry = [...alert.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重试',
    )!
    retry.click()
    await settle()
    expect(root.querySelector('.open-error')).toBeNull()
    expect(store.peek('s1')!.window.value.openState).toBe('open')
    expect(api.calls).toHaveLength(2)
  })

  it('5 · shows the skeleton, not an empty conversation, while a read is under way', async () => {
    const api = new FakeHistoryApi([...conversation().events])
    api.hold()
    const store = new ConversationStore({
      api: { history: (query) => api.history(query) },
      watch: vi.fn(async () => undefined),
      subscribe: () => () => undefined,
      scheduler: immediate,
    })
    const root = mount(store)
    await settle()
    expect(root.querySelector('.conversation-loading')).not.toBeNull()
    api.release()
    await settle()
    expect(root.querySelector('.conversation-loading')).toBeNull()
  })
})
