// @vitest-environment jsdom
// FIX-04 (UI-15): a streaming reply renders at most once per 80 ms; the
// final text renders at once when the stream ends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import ConversationMarkdown from './ConversationMarkdown.vue'
import { createExpansionStore, provideChatContext } from '../chatContext'

let container: HTMLDivElement | null = null
let app: ReturnType<typeof createApp> | null = null

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  vi.useRealTimers()
})

function mount(props: { text: string; streaming: boolean }) {
  const state = reactive({ ...props })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      provideChatContext({
        actions: {
          inspect: () => undefined,
          openSubagent: () => undefined,
          editMessage: () => undefined,
        },
        expansion: createExpansionStore(),
        sessionId: () => 's1',
      })
      return () => h(ConversationMarkdown, { ...state })
    },
  })
  app.mount(container)
  return { root: container, state }
}

const shownText = (root: HTMLElement) =>
  root.querySelector('.ds-md')?.textContent?.trim() ?? ''

describe('ConversationMarkdown streaming cadence', () => {
  it('renders a streaming reply at most once per 80 ms', async () => {
    const { root, state } = mount({ text: 'a', streaming: true })
    await nextTick()
    expect(shownText(root)).toBe('a')
    for (let index = 0; index < 10; index++) {
      vi.advanceTimersByTime(5)
      state.text += 'b'
      await nextTick()
    }
    // 50 ms after the first render: still the first text.
    expect(shownText(root)).toBe('a')
    vi.advanceTimersByTime(29)
    await nextTick()
    expect(shownText(root)).toBe('a')
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(shownText(root)).toBe(`a${'b'.repeat(10)}`)
    // After a quiet spell the next piece shows at once.
    vi.advanceTimersByTime(200)
    state.text += 'c'
    await nextTick()
    expect(shownText(root)).toBe(`a${'b'.repeat(10)}c`)
  })

  it('renders the final text at once when the stream ends', async () => {
    const { root, state } = mount({ text: 'start', streaming: true })
    await nextTick()
    vi.advanceTimersByTime(10)
    state.text = 'start and the rest'
    await nextTick()
    expect(shownText(root)).toBe('start')
    state.streaming = false
    await nextTick()
    expect(shownText(root)).toBe('start and the rest')
  })

  it('5 · shows an unclosed code fence as the code block tail', async () => {
    const { root } = mount({
      text: 'Intro paragraph.\n\n```ts\nconst a = 1\nconst b',
      streaming: true,
    })
    await nextTick()
    expect(root.querySelector('.ds-md-html p')?.textContent).toBe(
      'Intro paragraph.',
    )
    const code = root.querySelector('.ds-code')
    expect(code?.querySelector('.infostring')?.textContent).toBe('ts')
    expect(code?.querySelector('pre code')?.textContent).toBe(
      'const a = 1\nconst b',
    )
  })
})
