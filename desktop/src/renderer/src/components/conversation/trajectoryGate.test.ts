// @vitest-environment jsdom
// UI-S09: the trajectory gate — 设置 › 常规 › 开发者 › 显示轨迹 (default off)
// decides whether trajectory links open, whether tool rows offer Inspect,
// and where the trajectory route goes when the switch turns off.
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  reloadUiPreferences,
  setUiPreference,
} from '../../composables/useUiPreferences'
import ChatTimeline from './ChatTimeline.vue'
import { createFixtureStore, type FixtureStore } from './gallery/fixtureStore'
import { showcaseScenario } from './gallery/scenarios'
import {
  resetTrajectoryGateForTest,
  takeTrajectoryNotice,
  trajectoryNotice,
  trajectoryOffLocation,
  trajectoryRouteGuard,
} from './trajectoryGate'

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

beforeEach(() => {
  localStorage.clear()
  reloadUiPreferences()
  resetTrajectoryGateForTest()
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  fixture?.dispose()
  container = null
  app = null
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

const immediate = {
  frame: (callback: () => void) => queueMicrotask(callback),
  microtask: (callback: () => void) => queueMicrotask(callback),
}

type Timeline = { revealCall: (callId: string) => boolean }

function mountShowcase(): {
  root: HTMLDivElement
  timeline: { value: Timeline | null }
} {
  fixture = createFixtureStore(showcaseScenario(Date.now()).sessions, {
    scheduler: immediate,
  })
  container = document.createElement('div')
  document.body.append(container)
  const timeline = ref<Timeline | null>(null)
  const store = fixture.store
  app = createApp({
    render: () =>
      h(ChatTimeline, { sessionId: 'showcase', store, ref: timeline }),
  })
  app.use(
    createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { render: () => null } }],
    }),
  )
  app.mount(container)
  return { root: container, timeline }
}

function trajectoryRoute(query: Record<string, string> = {}) {
  return {
    name: 'trajectory',
    params: { sessionId: 's1' },
    query,
  }
}

describe('the trajectory route guard (UI-S09)', () => {
  it('3 · sends a trajectory link to the chat while 显示轨迹 is off, without call', () => {
    expect(
      trajectoryRouteGuard(
        trajectoryRoute({ call: 'call_grep', visualTheme: 'dark' }),
      ),
    ).toEqual({
      name: 'chat',
      params: { sessionId: 's1' },
      query: { visualTheme: 'dark' },
    })
    // ConversationView reads the notice: a toast, and the call revealed.
    expect(trajectoryNotice.value).toEqual({
      sessionId: 's1',
      callId: 'call_grep',
    })
    expect(takeTrajectoryNotice('other')).toBeNull()
    expect(takeTrajectoryNotice('s1')).toEqual({
      sessionId: 's1',
      callId: 'call_grep',
    })
    expect(takeTrajectoryNotice('s1')).toBeNull()

    trajectoryRouteGuard(trajectoryRoute())
    expect(takeTrajectoryNotice('s1')).toEqual({
      sessionId: 's1',
      callId: null,
    })
  })

  it('4 · lets the link through once 显示轨迹 is on', () => {
    setUiPreference('showTrajectory', true)
    expect(trajectoryRouteGuard(trajectoryRoute({ call: 'c1' }))).toBe(true)
    expect(trajectoryNotice.value).toBeNull()
  })

  it('5 · turns the trajectory route back into the chat when the switch goes off', () => {
    expect(
      trajectoryOffLocation(
        trajectoryRoute({ call: 'c1', settings: 'general' }),
      ),
    ).toEqual({
      name: 'chat',
      params: { sessionId: 's1' },
      query: { settings: 'general' },
    })
    expect(
      trajectoryOffLocation({
        name: 'chat',
        params: { sessionId: 's1' },
        query: {},
      }),
    ).toBeNull()
    expect(
      trajectoryOffLocation({ name: 'scheduler', params: {}, query: {} }),
    ).toBeNull()
  })
})

describe('tool rows under the trajectory gate (UI-S09)', () => {
  it('2 · offers no Inspect by default', async () => {
    setUiPreference('processDisplay', 'expanded')
    const { root } = mountShowcase()
    await settle()
    const row = root.querySelector<HTMLElement>(
      '.tool-row[data-call-id="call_lint"]',
    )!
    row.querySelector<HTMLElement>('[data-disclosure-row]')!.click()
    await settle()
    expect(row.querySelector('[data-terminal]')?.textContent).toContain(
      'npm run lint',
    )
    expect(row.querySelector('.inspect')).toBeNull()
    expect(row.textContent).not.toContain('查看')
  })

  it('4 · offers Inspect once 显示轨迹 is on', async () => {
    setUiPreference('processDisplay', 'expanded')
    setUiPreference('showTrajectory', true)
    const { root } = mountShowcase()
    await settle()
    const row = root.querySelector<HTMLElement>(
      '.tool-row[data-call-id="call_lint"]',
    )!
    row.querySelector<HTMLElement>('[data-disclosure-row]')!.click()
    await settle()
    expect(row.querySelector('.inspect')?.textContent).toContain('查看')
  })

  it('3 · revealCall opens the folded group and the call’s row', async () => {
    const { root, timeline } = mountShowcase()
    await settle()
    expect(root.querySelector('.tool-row[data-call-id="call_lint"]')).toBeNull()
    expect(timeline.value?.revealCall('call_lint')).toBe(true)
    await settle()
    const row = root.querySelector<HTMLElement>(
      '[data-process-body] .tool-row[data-call-id="call_lint"]',
    )
    expect(row).not.toBeNull()
    expect(
      row
        ?.querySelector('[data-disclosure-row]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true')
    expect(row?.querySelector('[data-terminal]')?.textContent).toContain(
      'npm run lint',
    )
    expect(timeline.value?.revealCall('missing')).toBe(false)
  })
})
