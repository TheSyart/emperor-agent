// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThoughtSegment } from '../../types'
import { createExpansionStore } from './messageListModel'
import { CHAT_EXPANSION_STORE_KEY } from './expansionStoreKey'
import ThoughtEvent from './ThoughtEvent.vue'

let container: HTMLDivElement | null = null
let app: ReturnType<typeof createApp> | null = null

function thought(extra: Partial<ThoughtSegment> = {}): ThoughtSegment {
  return {
    id: 'seg-1',
    type: 'thought',
    status: 'done',
    durationMs: 12_000,
    ...extra,
  }
}

function mount(
  segment: ThoughtSegment,
  opts: {
    executionDurationMs?: number
    store?: ReturnType<typeof createExpansionStore>
  } = {},
) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    render: () =>
      h(ThoughtEvent, {
        segment,
        executionDurationMs: opts.executionDurationMs,
      }),
  })
  if (opts.store) app.provide(CHAT_EXPANSION_STORE_KEY, opts.store)
  app.mount(container)
  return container
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('ThoughtEvent quote-block presentation', () => {
  it('expands the quote block with spinner while running', () => {
    const el = mount(
      thought({ status: 'running', summary: '先读配置再动手' }),
      {
        store: createExpansionStore(),
      },
    )
    const quote = el.querySelector('.thought-quote')
    expect(quote).toBeTruthy()
    expect(quote!.classList.contains('running')).toBe(true)
    expect(el.querySelector('.thought-spinner')).toBeTruthy()
    expect(el.textContent).toContain('思考中…')
    expect(el.querySelector('.thought-quote-body')?.textContent).toContain(
      '先读配置再动手',
    )
  })

  it('collapses to a single button row when done', () => {
    const el = mount(thought({ summary: '已完成的推理' }), {
      store: createExpansionStore(),
    })
    const btn = el.querySelector('button.thought-collapsed')
    expect(btn).toBeTruthy()
    expect(btn!.getAttribute('aria-expanded')).toBe('false')
    expect(btn!.textContent).toContain('思考了 12s')
    expect(el.querySelector('.thought-quote')).toBeNull()
  })

  it('toggles open and closed on click', async () => {
    const el = mount(thought({ summary: '推理内容' }), {
      store: createExpansionStore(),
    })
    const btn = el.querySelector<HTMLButtonElement>('button.thought-collapsed')!
    btn.click()
    await Promise.resolve()
    const head = el.querySelector<HTMLButtonElement>(
      'button.thought-quote-head',
    )
    expect(head).toBeTruthy()
    expect(head!.getAttribute('aria-expanded')).toBe('true')
    expect(el.querySelector('.thought-quote-body')?.textContent).toContain(
      '推理内容',
    )
    head!.click()
    await Promise.resolve()
    expect(el.querySelector('.thought-quote')).toBeNull()
    expect(el.querySelector('button.thought-collapsed')).toBeTruthy()
  })

  it('restores expansion state across remounts with the same segment id', () => {
    const store = createExpansionStore()
    let el = mount(thought({ summary: '推理内容' }), { store })
    el.querySelector<HTMLButtonElement>('button.thought-collapsed')!.click()
    app!.unmount()
    container!.remove()
    el = mount(thought({ summary: '推理内容' }), { store })
    expect(el.querySelector('.thought-quote')).toBeTruthy()
  })

  it('renders a non-interactive status line when no summary exists', () => {
    const el = mount(thought({ label: '整理工具结果', durationMs: 2600 }), {
      store: createExpansionStore(),
    })
    expect(el.querySelector('button')).toBeNull()
    expect(el.querySelector('.thought-chevron')).toBeNull()
    expect(el.textContent).toContain('整理工具结果 · 2.6s')
  })

  it('shows the aborted label for error_aborted', () => {
    const el = mount(
      thought({ status: 'error_aborted', summary: '半截推理' }),
      { store: createExpansionStore(), executionDurationMs: 8000 },
    )
    expect(el.textContent).toContain('执行已中断 · 8.0s')
  })

  it('does not auto-expand while running after the user collapsed it', () => {
    const store = createExpansionStore()
    store.setOpen('thought:seg-1', false)
    const el = mount(thought({ status: 'running', summary: '流式推理' }), {
      store,
    })
    expect(el.querySelector('.thought-quote')).toBeNull()
    expect(el.querySelector('button.thought-collapsed')).toBeTruthy()
  })

  it('falls back to local state without an expansion provider', async () => {
    const el = mount(thought({ summary: '推理内容' }))
    const btn = el.querySelector<HTMLButtonElement>('button.thought-collapsed')
    expect(btn).toBeTruthy()
    btn!.click()
    await Promise.resolve()
    expect(el.querySelector('.thought-quote')).toBeTruthy()
  })
})
