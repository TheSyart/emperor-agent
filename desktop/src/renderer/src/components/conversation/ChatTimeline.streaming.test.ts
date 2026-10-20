// @vitest-environment jsdom
// FIX-04 (UI-14): streaming into a 500-turn session must not re-render the
// virtual list wholesale. Only the streaming row's seat renders; the
// timeline, the DynamicScroller and its items do not, and the rows are not
// rebuilt.
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createMemoryHistory } from 'vue-router'
import ChatTimeline from './ChatTimeline.vue'
import { createFixtureStore, type FixtureStore } from './gallery/fixtureStore'
import {
  longMarkdownReply,
  longSessionLog,
  streamChunks,
} from '../../conversation/testing/streaming'
import { reloadUiPreferences } from '../../composables/useUiPreferences'

const rows = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./processModel', async (original) => {
  const actual = await original<typeof import('./processModel')>()
  return {
    ...actual,
    timelineRowsOf: (...args: Parameters<typeof actual.timelineRowsOf>) => {
      rows.calls++
      return actual.timelineRowsOf(...args)
    },
  }
})

// vue-virtual-scroller's visibility directive expects IntersectionObserver.
globalThis.IntersectionObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
} as unknown as typeof IntersectionObserver

let container: HTMLDivElement | null = null
let app: ReturnType<typeof createApp> | null = null
let fixture: FixtureStore | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  fixture?.dispose()
  app = null
  container = null
  fixture = null
  localStorage.clear()
  reloadUiPreferences()
})

async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await Promise.resolve()
    await nextTick()
  }
}

/**
 * jsdom has no layout: report the page-mode list as scrolled to its end
 * (the reader follows the stream), so the virtual list shows the last rows.
 */
function scrollListToEnd(root: HTMLElement): void {
  const list = root.querySelector<HTMLElement>('.vue-recycle-scroller')!
  const wrapper = list.querySelector<HTMLElement>(
    '.vue-recycle-scroller__item-wrapper',
  )!
  const total = Number.parseFloat(
    wrapper.style.minHeight || wrapper.style.height,
  )
  list.getBoundingClientRect = () =>
    ({
      top: -(total - 400),
      bottom: 400,
      height: total,
      left: 0,
      right: 748,
      width: 748,
      x: 0,
      y: -(total - 400),
      toJSON: () => ({}),
    }) as DOMRect
  window.dispatchEvent(new Event('scroll'))
}

const immediate = {
  frame: (callback: () => void) => queueMicrotask(callback),
  microtask: (callback: () => void) => queueMicrotask(callback),
}

describe('ChatTimeline streaming into a 500-turn session (FIX-04)', () => {
  it('3 · renders only the streaming seat, never the virtual list wholesale', async () => {
    const session = longSessionLog(500)
    fixture = createFixtureStore([{ id: 'long', events: session.events }], {
      scheduler: immediate,
      pageMessages: 1_000_000,
    })
    container = document.createElement('div')
    document.body.append(container)
    const renders = new Map<string, number>()
    const seats = new Set<string>()
    app = createApp({
      render: () =>
        h(ChatTimeline, { sessionId: 'long', store: fixture!.store }),
    })
    app.mixin({
      updated(this: {
        $options: { __name?: string; name?: string }
        $props?: { nodeKey?: string }
      }) {
        const name = this.$options.__name ?? this.$options.name ?? '?'
        renders.set(name, (renders.get(name) ?? 0) + 1)
        if (name === 'ChatNodeSeat' && this.$props?.nodeKey)
          seats.add(this.$props.nodeKey)
      },
    })
    app.use(
      createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/', component: { render: () => null } }],
      }),
    )
    app.mount(container)
    await settle(40)
    const handle = fixture.store.peek('long')!
    expect(handle.window.value.openState).toBe('open')
    expect(handle.order.value.length).toBeGreaterThan(1700)
    // The first text shows the answer row (one structural change).
    const chunks = streamChunks(session, longMarkdownReply(4_000), 8)
    fixture.emit('long', [chunks[0]!])
    await settle()
    const streamKey = handle.order.value.at(-1)!
    expect(handle.node(streamKey).value?.kind).toBe('assistant')
    scrollListToEnd(container)
    // The list updates on the next animation frame.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await settle()
    expect(
      container.querySelector(`[data-chat-anchor-key="${streamKey}"]`),
    ).not.toBeNull()

    renders.clear()
    rows.calls = 0
    for (const chunk of chunks.slice(1, 201)) {
      fixture.emit('long', [chunk])
      await settle(2)
    }
    await settle()

    expect(rows.calls).toBe(0)
    for (const name of [
      'ChatTimeline',
      'DynamicScroller',
      'RecycleScroller',
      'DynamicScrollerItem',
      'ProcessGroup',
      'TurnStatus',
    ])
      expect(renders.get(name) ?? 0, name).toBe(0)
    expect([...seats]).toEqual([streamKey])
    expect(renders.get('ChatNodeSeat') ?? 0).toBeGreaterThan(0)
  })
})
