// @vitest-environment jsdom
// UI-S03: process groups in the mounted ChatTimeline — the live line, the
// folded line, the 处理过程 / 显示系统步骤 preferences, preparing calls, the
// truncation note and the hover-only turn tail.
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import { conversationContextKey } from '../../conversation/assembler'
import { LogBuilder } from '../../conversation/testing/fixtures'
import {
  reloadUiPreferences,
  setUiPreference,
} from '../../composables/useUiPreferences'
import ChatTimeline from './ChatTimeline.vue'
import { createFixtureStore, type FixtureStore } from './gallery/fixtureStore'
import { noticesScenario, showcaseScenario } from './gallery/scenarios'

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

type Timeline = { scrollToKey: (key: string) => boolean }

function mount(
  sessionId: string,
  sessions: Parameters<typeof createFixtureStore>[0],
): { root: HTMLDivElement; timeline: { value: Timeline | null } } {
  fixture = createFixtureStore(sessions, { scheduler: immediate })
  container = document.createElement('div')
  document.body.append(container)
  const timeline = ref<Timeline | null>(null)
  const store = fixture.store
  app = createApp({
    render: () => h(ChatTimeline, { sessionId, store, ref: timeline }),
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

const groups = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-process-group]'),
]
const header = (group: HTMLElement) =>
  group.querySelector<HTMLElement>('[data-process-header]')!
const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''

/** A two-step turn: think + read, then the answer. */
function liveTurn(): {
  history: WireSessionEvent[]
  parts: WireSessionEvent[][]
} {
  const log = new LogBuilder()
  log.user('u1', '看看设置页')
  log.add('turn/start', { turn: 1 })
  log.add('step/start', { turn: 1, step: 1 })
  const history = [...log.events]
  const mark = () => log.events.length
  let from = mark()
  const parts: WireSessionEvent[][] = []
  const cut = () => {
    parts.push(log.events.slice(from))
    from = mark()
  }
  log.chunk(1, 1, { type: 'block-start', index: 0, blockType: 'reasoning' })
  log.chunk(1, 1, { type: 'reasoning-delta', index: 0, text: '先读设置页。' })
  log.chunk(1, 1, { type: 'block-start', index: 1, blockType: 'tool-call' })
  log.chunk(1, 1, {
    type: 'tool-call-delta',
    index: 1,
    id: 'r1',
    name: 'read',
    argumentsDelta: '{"file_path":"src/views/SettingsView.vue"',
  })
  cut()
  log.message(1, 1, [
    { type: 'reasoning', text: '先读设置页。' },
    {
      type: 'tool-call',
      id: 'r1',
      name: 'read',
      arguments: '{"file_path":"src/views/SettingsView.vue"}',
    },
  ])
  log.call(1, 1, 'r1', 'read', { file_path: 'src/views/SettingsView.vue' })
  cut()
  log.result(1, 1, 'r1', 'file text')
  log.add('step/end', { turn: 1, step: 1 })
  cut()
  log.add('step/start', { turn: 1, step: 2 })
  log.message(1, 2, [{ type: 'text', text: '设置页没有问题。' }])
  log.add('step/end', { turn: 1, step: 2 })
  log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  cut()
  return { history, parts }
}

describe('process groups (UI-S03)', () => {
  it('1 · a running process renders one line that follows the events', async () => {
    const { history, parts } = liveTurn()
    const { root } = mount('live', [{ id: 'live', events: history }])
    await settle()
    expect(groups(root)).toHaveLength(0)
    expect(root.querySelector('.turn-status')).not.toBeNull()

    fixture!.emit('live', parts[0]!)
    await settle()
    const [group] = groups(root)
    expect(group?.hasAttribute('data-live')).toBe(true)
    expect(text(header(group!))).toContain('准备读取 SettingsView.vue')
    expect(text(header(group!))).toContain('第 2 步')
    expect(group!.querySelector('[data-process-body]')).toBeNull()
    expect(root.querySelector('.tool-row')).toBeNull()
    expect(root.querySelector('.reasoning')).toBeNull()
    // The live line is the status line: no second one below it.
    expect(root.querySelector('.turn-status')).toBeNull()

    fixture!.emit('live', parts[1]!)
    await settle()
    expect(text(header(groups(root)[0]!))).toContain(
      '正在读取 SettingsView.vue',
    )
    fixture!.emit('live', parts[2]!)
    await settle()
    expect(text(header(groups(root)[0]!))).toContain('正在思考')
    expect(text(header(groups(root)[0]!))).toContain('第 3 步')
  })

  it('2 · a finished turn folds to 已处理 N 步 · 用时 X with N = the steps', async () => {
    const { history, parts } = liveTurn()
    const { root } = mount('done', [
      { id: 'done', events: [...history, ...parts.flat()] },
    ])
    await settle()
    const [group] = groups(root)
    expect(group?.hasAttribute('data-live')).toBe(false)
    expect(text(header(group!))).toMatch(/^已处理 2 步 · 用时 \d+ 秒$/u)
    header(group!).click()
    await settle()
    expect(
      group!.querySelectorAll('[data-process-body] [data-process-step]'),
    ).toHaveLength(2)
    // The answer sits after the folded line, outside it.
    const answer = [...root.querySelectorAll('.assistant-step')].find(
      (step) => step.closest('[data-process-group]') === null,
    )
    expect(text(answer)).toBe('设置页没有问题。')
    expect(
      group!.compareDocumentPosition(answer!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('3 · clicking the folded line expands every step and clicking again folds it', async () => {
    const { root } = mount('showcase', showcaseScenario(Date.now()).sessions)
    await settle()
    const [group] = groups(root)
    expect(groups(root)).toHaveLength(1)
    expect(text(header(group!))).toMatch(/^已处理 11 步 · 用时 /u)
    expect(header(group!).getAttribute('aria-expanded')).toBe('false')
    header(group!).click()
    await settle()
    expect(header(group!).getAttribute('aria-expanded')).toBe('true')
    expect(
      group!.querySelectorAll('[data-process-body] [data-process-step]'),
    ).toHaveLength(11)
    expect(group!.querySelectorAll('.tool-row')).toHaveLength(10)
    header(group!).click()
    await settle()
    expect(group!.querySelector('[data-process-body]')).toBeNull()
  })

  it('4 · 始终展开 shows every step without a click', async () => {
    setUiPreference('processDisplay', 'expanded')
    const { root } = mount('showcase', showcaseScenario(Date.now()).sessions)
    await settle()
    const [group] = groups(root)
    expect(group!.querySelector('[data-process-body]')).not.toBeNull()
    expect(header(group!).getAttribute('aria-expanded')).toBe('true')
  })

  it('完成后收起 folds a group opened while it ran; 始终收起 leaves it to the reader', async () => {
    for (const mode of ['collapse-when-done', 'collapsed'] as const) {
      setUiPreference('processDisplay', mode)
      const { history, parts } = liveTurn()
      const { root } = mount(mode, [{ id: mode, events: history }])
      await settle()
      fixture!.emit(mode, [...parts[0]!, ...parts[1]!])
      await settle()
      header(groups(root)[0]!).click()
      await settle()
      expect(groups(root)[0]!.querySelector('[data-process-body]')).not.toBe(
        null,
      )
      fixture!.emit(mode, [...parts[2]!, ...parts[3]!])
      await settle()
      const open = groups(root)[0]!.querySelector('[data-process-body]')
      expect(open === null, mode).toBe(mode === 'collapse-when-done')
      app?.unmount()
      container?.remove()
      fixture?.dispose()
    }
  })

  it('5 · ContextRow and HookRow render only with 显示系统步骤', async () => {
    setUiPreference('processDisplay', 'expanded')
    const sessions = [
      ...showcaseScenario(Date.now()).sessions,
      ...noticesScenario(Date.now()).sessions,
    ]
    let { root } = mount('showcase', sessions)
    await settle()
    expect(root.querySelector('.context-row')).toBeNull()
    app?.unmount()
    container?.remove()
    fixture?.dispose()
    ;({ root } = mount('notices', sessions))
    await settle()
    expect(root.querySelector('.hook-row')).toBeNull()
    expect(root.querySelector('.context-row')).toBeNull()
    app?.unmount()
    container?.remove()
    fixture?.dispose()

    setUiPreference('showSystemSteps', true)
    ;({ root } = mount('showcase', sessions))
    await settle()
    expect(
      root.querySelector('[data-process-body] .context-row'),
    ).not.toBeNull()
    app?.unmount()
    container?.remove()
    fixture?.dispose()
    ;({ root } = mount('notices', sessions))
    await settle()
    expect(root.querySelector('.hook-row')).not.toBeNull()
  })

  it('6 · a call still being written shows 准备中 and the file name', async () => {
    setUiPreference('processDisplay', 'expanded')
    const { history, parts } = liveTurn()
    const { root } = mount('prep', [
      { id: 'prep', events: [...history, ...parts[0]!] },
    ])
    await settle()
    const row = root.querySelector<HTMLElement>('.tool-row[data-preparing]')
    expect(row).not.toBeNull()
    expect(text(row)).toContain('读取')
    expect(text(row)).toContain('SettingsView.vue')
    expect(text(row)).toContain('准备中')
    expect(
      row?.querySelector('[data-disclosure-row]')?.getAttribute('role'),
    ).toBeNull()
  })

  it('7 · the truncation note names the trajectory only when it is shown', async () => {
    setUiPreference('processDisplay', 'expanded')
    const build = () => {
      const log = new LogBuilder()
      log.user('u1', 'write it')
      log.add('turn/start', { turn: 1 })
      log.add('step/start', { turn: 1, step: 1 })
      log.message(1, 1, [
        { type: 'tool-call', id: 'w1', name: 'write', arguments: '{}' },
      ])
      log.add(
        'tool/call',
        {
          turn: 1,
          step: 1,
          callId: 'w1',
          name: 'write',
          arguments: '{"file_path":"big.txt","content":"aaaa',
        },
        { wire: { field: 'arguments', truncated: true } },
      )
      log.result(1, 1, 'w1', 'ok')
      log.add('step/end', { turn: 1, step: 1 })
      log.add('step/start', { turn: 1, step: 2 })
      log.message(1, 2, [{ type: 'text', text: '写好了。' }])
      log.add('step/end', { turn: 1, step: 2 })
      log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return log.events
    }
    const note = async (): Promise<string> => {
      const { root } = mount('trunc', [{ id: 'trunc', events: build() }])
      await settle()
      root
        .querySelector<HTMLElement>(
          '.tool-row[data-call-id="w1"] [data-disclosure-row]',
        )!
        .click()
      await settle()
      const value = text(root.querySelector('.truncated-note'))
      app?.unmount()
      container?.remove()
      fixture?.dispose()
      return value
    }
    expect(await note()).toBe('参数过长，已截断显示')
    setUiPreference('showTrajectory', true)
    expect(await note()).toBe('参数过长，已截断显示；在轨迹中查看完整内容')
  })

  it('reveals a step inside a folded group (scrubber, plan row)', async () => {
    const { root, timeline } = mount(
      'showcase',
      showcaseScenario(Date.now()).sessions,
    )
    await settle()
    expect(root.querySelector('.tool-row[data-call-id="call_lint"]')).toBeNull()
    expect(
      timeline.value?.scrollToKey(conversationContextKey('tool', 'call_lint')),
    ).toBe(true)
    await settle()
    expect(
      root.querySelector(
        '[data-process-body] .tool-row[data-call-id="call_lint"]',
      ),
    ).not.toBeNull()
  })

  it('reports a folded group to the scrubber as its first step', async () => {
    const { history, parts } = liveTurn()
    const { root } = mount('done', [
      { id: 'done', events: [...history, ...parts.flat()] },
    ])
    await settle()
    const group = groups(root)[0]!
    expect(
      group
        .closest('[data-chat-anchor-key]')
        ?.getAttribute('data-chat-flow-kind'),
    ).toBe('process')
  })

  it('shows the turn’s copy and 用时 only while the turn is hovered', async () => {
    const { history, parts } = liveTurn()
    const { root } = mount('tail', [
      { id: 'tail', events: [...history, ...parts.flat()] },
    ])
    await settle()
    const tail = root.querySelector<HTMLElement>('[data-turn-tail]')!
    expect(tail.hasAttribute('data-revealed')).toBe(false)
    root
      .querySelector('.assistant-step')!
      .dispatchEvent(new Event('pointerover', { bubbles: true }))
    await settle()
    expect(tail.hasAttribute('data-revealed')).toBe(true)
    root
      .querySelector('[data-chat-flow]')!
      .dispatchEvent(new Event('pointerleave'))
    await settle()
    expect(tail.hasAttribute('data-revealed')).toBe(false)
  })
})
