// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { loadKernelLog, LogBuilder } from '../../conversation/testing/fixtures'
import ChatTimeline from './ChatTimeline.vue'
import { buildAgentTree, useAgentTree } from '../sidebar/agentTree'
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
let router: Router

afterEach(() => {
  app?.unmount()
  container?.remove()
  fixture?.dispose()
  container = null
  app = null
  fixture = null
  delete useAgentTree().trees['native-root']
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
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/chat/:sessionId',
        name: 'chat',
        component: { render: () => null },
      },
      {
        path: '/chat/:sessionId/agents/:delegationId',
        name: 'external-agent',
        component: { render: () => null },
      },
    ],
  })
  app.use(router)
  app.mount(container)
  return container
}

describe('ChatTimeline over the recorded kernel log', () => {
  it('shows an external agents partial output and tools before native completion', async () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.call(1, 1, 'external-call', 'subagent', {
      backend: 'codex',
      description: 'live work',
    })
    const root = mount('live-external', [
      { id: 'live-external', events: [...log.events] },
    ])
    await settle()
    fixture!.emit('live-external', [
      log.add('delegation/projection', {
        event: 'delegation_output',
        delegation_id: 'dlg-one',
        run_id: 'dgr-one',
        current_run_id: 'dgr-one',
        parent_call_id: 'external-call',
        backend: 'codex',
        journal_seq: 1,
        output: [
          { role: 'assistant', content: '正在读取项目' },
          {
            role: 'tool',
            content: JSON.stringify({
              name: 'shell',
              type: 'tool_started',
              detail: 'read README',
            }),
          },
        ],
      }),
    ])
    await settle()
    const live = root.querySelector('[data-external-agent-stream]')
    expect(live?.textContent).toContain('Codex')
    expect(live?.querySelector('[data-agent-logo="codex"]')).not.toBeNull()
    expect(live?.textContent).toContain('正在读取项目')
    expect(live?.textContent).toContain('shell')
    const entry = root.querySelector<HTMLAnchorElement>('[data-agent-entry]')
    expect(entry?.textContent).toContain('live work')
    expect(entry?.getAttribute('href')).toBe(
      '/chat/live-external/agents/dlg-one',
    )
    expect(
      root.querySelector('[data-agent-details]')?.textContent?.trim(),
    ).toBe('任务详情')
    expect(entry?.querySelector('button')).toBeNull()
    const toggle = live?.querySelector<HTMLButtonElement>('.stream-toggle')
    toggle?.click()
    await settle()
    expect(live?.querySelector('.stream-content')).toBeNull()
    expect(root.querySelector('[data-agent-entry]')).not.toBeNull()
    entry?.click()
    await settle()
    expect(router.currentRoute.value.name).toBe('external-agent')
    expect(router.currentRoute.value.params).toEqual({
      sessionId: 'live-external',
      delegationId: 'dlg-one',
    })
  })
  it('keeps a continued external run on its creation name and stable dlg route', async () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.call(1, 1, 'followup-call', 'send_message', {
      agent_id: 'dlg-one',
      message: 'new prompt changes scope',
    })
    log.add('delegation/projection', {
      event: 'delegation_run_changed',
      delegation_id: 'dlg-one',
      run_id: 'dgr-next',
      current_run_id: 'dgr-next',
      parent_call_id: 'followup-call',
      backend: 'codex',
      journal_seq: 2,
      task: { description: 'original creation task', status: 'waiting_input' },
    })
    const root = mount('root', [{ id: 'root', events: [...log.events] }])
    await settle()
    const entry = root.querySelector<HTMLAnchorElement>('[data-agent-entry]')!
    expect(entry.textContent).toContain('original creation task')
    expect(entry.textContent).not.toContain('new prompt changes scope')
    expect(entry.getAttribute('href')).toBe('/chat/root/agents/dlg-one')
    expect(root.querySelector('.tool-row')?.textContent).toContain(
      'original creation task',
    )
    expect(root.querySelector('.tool-row')?.textContent).toContain(
      'Codex · 等待回答',
    )
    expect(root.querySelector('[data-agent-details]')?.closest('a')).toBeNull()
  })
  it('resolves native continuation identity and creation title from the shared root tree without a new started event', async () => {
    const log = new LogBuilder()
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.call(1, 1, 'native-followup', 'send_message', {
      subagent_id: 'sub-existing',
      message: 'different followup task',
    })
    log.result(1, 1, 'native-followup', 'queued', {
      meta: { messageId: 'msg-next', subagentId: 'sub-existing' },
    })
    const opened: string[] = []
    const root = mount(
      'native-root',
      [{ id: 'native-root', events: [...log.events] }],
      { openSubagent: (id) => opened.push(id) },
    )
    await settle()
    expect(root.querySelector('[data-agent-entry]')).toBeNull()
    // Hydration can finish after the continuation card is already mounted.
    useAgentTree().trees['native-root'] = buildAgentTree('native-root', [
      {
        id: 'sub-existing',
        kind: 'internal',
        backend: 'internal',
        rootSessionId: 'native-root',
        parentAgentId: 'native-root',
        title: 'original native creation',
        phase: 'running',
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    await settle()
    const entry = root.querySelector<HTMLAnchorElement>('[data-agent-entry]')!
    expect(entry?.textContent).toContain('original native creation')
    expect(entry?.textContent).toContain('Emperor')
    expect(entry?.getAttribute('href')).toBe('/chat/sub-existing')
    expect(
      entry.querySelector('[data-agent-identity="sub-existing"]'),
    ).not.toBeNull()
    expect(
      root.querySelector('.tool-row [data-agent-identity="sub-existing"]'),
    ).not.toBeNull()
    expect(root.querySelector('.tool-row')?.textContent).toContain(
      'original native creation',
    )
    expect(root.querySelector('.tool-row')?.textContent).toContain(
      'Emperor · 运行中',
    )
    entry.click()
    expect(opened).toEqual(['sub-existing'])
    root.querySelector<HTMLButtonElement>('[data-disclosure-row]')!.click()
    await settle()
    expect(root.textContent).toContain('different followup task')
    useAgentTree().trees['native-root'].byId['sub-existing'].rootSessionId =
      'foreign-root'
    await settle()
    expect(root.querySelector('[data-agent-entry]')).toBeNull()
  })

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
    expect(tools[3]).toContain('research')
    expect(tools[3]).toContain('Emperor · 已完成')
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
    root.querySelector<HTMLButtonElement>('[data-agent-entry]')?.click()
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
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        {
          path: '/chat/:sessionId',
          name: 'chat',
          component: { render: () => null },
        },
        {
          path: '/chat/:sessionId/agents/:delegationId',
          name: 'external-agent',
          component: { render: () => null },
        },
      ],
    })
    app.use(router)
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
