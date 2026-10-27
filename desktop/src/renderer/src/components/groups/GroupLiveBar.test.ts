// @vitest-environment jsdom
/**
 * GRP-08 (D6): the line above the composer — who speaks, who waits, how
 * long this turn has run, how many speeches and what it cost, live; no cap
 * and no warning, ever.
 */
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { GroupTurnView } from './groupModel'

const { default: GroupLiveBar } = await import('./GroupLiveBar.vue')

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let now = 193_000

const state = reactive({
  turn: {
    turnId: 't1',
    state: 'speaking',
    spend: { usd: 0.86, tokens: 1200 },
    startedAt: 1_000,
    speakers: ['ct-arch'],
    queued: ['ct-wri'],
  } as GroupTurnView | null,
  speeches: 7,
})

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(GroupLiveBar, {
      ...state,
      names: { 'ct-arch': '架构师', 'ct-wri': '写作者', 'ct-rev': '审稿人' },
      tasks: ['ct-wri'],
      clock: () => now,
    }),
  )
  app.mount(container)
  await flush()
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('the live bar', () => {
  it('shows who speaks, who waits, the time, the speeches and the spend, with no cap', async () => {
    await mount()
    const bar = document.querySelector<HTMLElement>('[data-live-bar]')!
    expect(bar.textContent).toContain('正在发言：架构师')
    expect(bar.textContent).toContain('排队：写作者（交办）')
    expect(bar.textContent).toContain('本轮 3 分 12 秒 · 7 次发言 · $0.86')
    expect(bar.textContent).not.toMatch(/上限提醒|超出|预算/)

    // The spend follows group_turn_changed.
    state.turn = {
      ...state.turn!,
      spend: { usd: 1.5, tokens: 3000 },
      speakers: ['ct-rev'],
      queued: [],
    }
    state.speeches = 8
    now = 200_000
    await flush()
    expect(bar.textContent).toContain('正在发言：审稿人')
    expect(bar.textContent).not.toContain('排队')
    expect(bar.textContent).toContain('本轮 3 分 19 秒 · 8 次发言 · $1.50')
  })

  it('stays out of the way before the first turn', async () => {
    state.turn = null
    await mount()
    expect(document.querySelector('[data-live-bar]')).toBeNull()
  })
})
