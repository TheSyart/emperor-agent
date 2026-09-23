// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { loadKernelLog } from '../../conversation/testing/fixtures'
import ChatTimeline from './ChatTimeline.vue'
import { createFixtureStore, type FixtureStore } from './gallery/fixtureStore'
import { showcaseScenario, streamingScenario } from './gallery/scenarios'
import {
  closingAssistantKeys,
  splitMarkdownFences,
  turnStatusLabel,
} from './timelineModel'

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
  container = null
  app = null
  fixture = null
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

function mount(
  sessionId: string,
  sessions: Parameters<typeof createFixtureStore>[0],
  events: Record<string, (value: string) => void> = {},
): HTMLDivElement {
  fixture = createFixtureStore(sessions, { scheduler: immediate })
  container = document.createElement('div')
  document.body.append(container)
  const store = fixture.store
  app = createApp({
    render: () =>
      h(ChatTimeline, {
        sessionId,
        store,
        onInspect: events.inspect,
        'onOpen-subagent': events.openSubagent,
      }),
  })
  app.mount(container)
  return container
}

describe('ChatTimeline over the recorded kernel log', () => {
  it('renders every chat row kind of the fixture', async () => {
    const log = loadKernelLog()
    const root = mount('kernel', [
      { id: 'kernel', events: [...log.root.events] },
      ...log.children.map((child) => ({
        id: child.header.id,
        events: [...child.events],
      })),
    ])
    await settle()
    const kinds = [
      ...root.querySelectorAll<HTMLElement>('[data-chat-flow-kind]'),
    ].map((el) => el.dataset.chatFlowKind)
    expect(kinds).toEqual([
      'user',
      'context',
      'context',
      'retry',
      'assistant',
      'tool',
      'tool',
      'tool',
      'tool',
      'assistant',
      'turnTail',
      'compaction',
    ])
    expect(root.querySelector('.user-bubble')?.textContent).toBe(
      'pick a color (shown)',
    )
    const tools = [...root.querySelectorAll('.tool-row')].map((el) =>
      el.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(tools[0]).toContain('终端')
    expect(tools[0]).toContain('print alpha')
    expect(tools[2]).toContain('已回答 1/1 · Which color?')
    expect(tools[3]).toContain('research · 已完成')
    expect(root.querySelector('[data-subagent-line]')?.textContent).toContain(
      'child found x',
    )
    expect(root.textContent).toContain('已压缩 10 条消息')
    expect(root.querySelector('.turn-status')).toBeNull()
  })

  it('routes inspect and open-subagent through its emits', async () => {
    const log = loadKernelLog()
    const inspected: string[] = []
    const opened: string[] = []
    const root = mount(
      'kernel',
      [{ id: 'kernel', events: [...log.root.events] }],
      {
        inspect: (id) => inspected.push(id),
        openSubagent: (id) => opened.push(id),
      },
    )
    await settle()
    root
      .querySelector<HTMLButtonElement>('[data-subagent-line] .open-link')
      ?.click()
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/^sub-/)
    const bash = root.querySelector<HTMLElement>(
      '.tool-row[data-call-id="call_bash_a"]',
    )
    bash?.querySelector<HTMLElement>('[data-disclosure-row]')?.click()
    await settle()
    expect(bash?.querySelector('[data-terminal]')?.textContent).toContain(
      'echo alpha',
    )
    bash?.querySelector<HTMLButtonElement>('.inspect')?.click()
    expect(inspected).toEqual(['call_bash_a'])
  })
})

describe('ChatTimeline live flow', () => {
  it('shows the turn status while running and streams new rows', async () => {
    const scenario = streamingScenario(Date.now(), 'all')
    const session = scenario.sessions[0]!
    const root = mount(session.id, [{ id: session.id, events: session.events }])
    await settle()
    expect(root.querySelector('.turn-status')?.textContent).toContain('思考中')
    fixture!.emit(session.id, session.live ?? [])
    await settle()
    expect(root.querySelector('.reasoning')).not.toBeNull()
    expect(root.textContent).toContain('会话持久化分三层')
    expect(
      root
        .querySelector('.tool-row[data-call-id="live_read"]')
        ?.getAttribute('data-state'),
    ).toBe('running')
    expect(root.querySelector('.turn-status')?.textContent).toContain('读取中')
  })

  it('renders the showcase turn with its tail and final markdown', async () => {
    const scenario = showcaseScenario(Date.now())
    const root = mount('showcase', scenario.sessions)
    await settle()
    expect(root.querySelector('[data-turn-tail]')).not.toBeNull()
    expect(root.querySelector('.ds-md table')).not.toBeNull()
    expect(root.querySelector('.ds-md .ds-code')).not.toBeNull()
    const lint = root.querySelector('.tool-row[data-call-id="call_lint"]')
    expect(lint?.getAttribute('data-state')).toBe('error')
  })
})

describe('ChatTimeline reveal', () => {
  it('scrolls to a loaded row by key and rejects unknown keys', async () => {
    const scenario = showcaseScenario(Date.now())
    fixture = createFixtureStore(scenario.sessions, { scheduler: immediate })
    container = document.createElement('div')
    document.body.append(container)
    const store = fixture.store
    const timeline = ref<{ scrollToKey: (key: string) => boolean } | null>(null)
    app = createApp({
      render: () =>
        h(ChatTimeline, { sessionId: 'showcase', store, ref: timeline }),
    })
    app.mount(container)
    await settle()
    const key = container
      .querySelector<HTMLElement>('[data-chat-anchor-key]')
      ?.getAttribute('data-chat-anchor-key')
    expect(key).toBeTruthy()
    expect(timeline.value?.scrollToKey(key!)).toBe(true)
    expect(timeline.value?.scrollToKey('missing-key')).toBe(false)
  })
})

describe('timeline model', () => {
  it('splits markdown fences, keeping an open trailing fence as code', () => {
    expect(
      splitMarkdownFences('a\n\n```ts\nconst x = 1\n```\nb\n```sh\necho'),
    ).toEqual([
      { kind: 'markdown', text: 'a\n' },
      { kind: 'code', lang: 'ts', code: 'const x = 1', open: false },
      { kind: 'markdown', text: 'b' },
      { kind: 'code', lang: 'sh', code: 'echo', open: true },
    ])
  })

  it('labels the running turn from the flow tip', () => {
    const snap = (node: unknown) =>
      ({ order: ['a'], nodes: new Map([['a', node]]) }) as never
    expect(
      turnStatusLabel(
        snap({
          kind: 'assistant',
          data: { status: 'running', blocks: [{ kind: 'text', text: 'x' }] },
        }),
      ),
    ).toBe('正在回复…')
    expect(
      turnStatusLabel(
        snap({
          kind: 'assistant',
          data: {
            status: 'running',
            blocks: [{ kind: 'reasoning', text: 'x' }],
          },
        }),
      ),
    ).toBe('思考中…')
    expect(
      turnStatusLabel(
        snap({ kind: 'retry', data: { current: { state: 'scheduled' } } }),
      ),
    ).toBe('等待重试…')
    expect(
      closingAssistantKeys(
        ['a', 'b'],
        new Map([
          ['a', { kind: 'assistant' }],
          ['b', { kind: 'turnTail' }],
        ]) as never,
      ),
    ).toEqual(new Set(['a']))
  })
})
