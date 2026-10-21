// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { loadKernelLog, LogBuilder } from '../../conversation/testing/fixtures'
import { ConversationStore } from '../../conversation/store'
import { conversationContextKey } from '../../conversation/assembler'
import type { SessionHistoryPage } from '@emperor/core/runtime-contract'
import ChatTimeline from './ChatTimeline.vue'
import { buildAgentTree, useAgentTree } from '../sidebar/agentTree'
import {
  reloadUiPreferences,
  setUiPreference,
} from '../../composables/useUiPreferences'
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
let delayedStore: ConversationStore | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  fixture?.dispose()
  delayedStore?.dispose()
  delayedStore = null
  container = null
  app = null
  fixture = null
  delete useAgentTree().trees['native-root']
  localStorage.clear()
  reloadUiPreferences()
})

/** Open the (single) process group of the mounted timeline. */
async function openProcess(root: HTMLElement): Promise<void> {
  const header = root.querySelector<HTMLElement>('[data-process-header]')
  if (header?.getAttribute('aria-expanded') === 'false') header.click()
  await settle()
}

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

/** The mounted ChatTimeline's exposed API. */
let timeline: {
  scrollToKey: (key: string) => boolean
  revealAgents: (id: string) => boolean
} | null = null

function mount(
  sessionId: string,
  sessions: Parameters<typeof createFixtureStore>[0],
  events: Record<string, (value: string) => void> = {},
  customStore?: ConversationStore,
  extra: Record<string, unknown> = {},
): HTMLDivElement {
  fixture = createFixtureStore(sessions, { scheduler: immediate })
  container = document.createElement('div')
  document.body.append(container)
  const store = customStore ?? fixture.store
  app = createApp({
    render: () =>
      h(ChatTimeline, {
        sessionId,
        store,
        onInspect: events.inspect,
        'onOpen-subagent': events.openSubagent,
        ref: (instance: unknown) => {
          timeline = instance as typeof timeline
        },
        ...extra,
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
  it.each(['resolve', 'reject'] as const)(
    'shows an initial loading transition until delayed history %ss',
    async (outcome) => {
      let resolve!: (page: SessionHistoryPage) => void
      let reject!: (error: Error) => void
      delayedStore = new ConversationStore({
        api: {
          history: () =>
            new Promise<SessionHistoryPage>((yes, no) => {
              resolve = yes
              reject = no
            }),
        },
        watch: async () => undefined,
        subscribe: () => () => {},
        scheduler: immediate,
      })
      const root = mount('delayed', [], {}, delayedStore)
      await settle()
      expect(root.querySelector('[aria-busy="true"]')).not.toBeNull()
      if (outcome === 'resolve')
        resolve({
          header: { version: 0, id: 'delayed', createdAt: 0 },
          events: [],
          hasMore: false,
          lastSeq: -1,
        } as SessionHistoryPage)
      else reject(new Error('history offline'))
      await settle()
      expect(root.querySelector('[aria-busy="true"]')).toBeNull()
      // FIX-03: the message, then 重试.
      expect(
        root.querySelector('[role="alert"] span')?.textContent?.trim() ?? '',
      ).toBe(outcome === 'reject' ? '会话记录读取失败：history offline' : '')
    },
  )

  it('shows an external subagent as one row with its logo; 任务详情 stays beside it (UI-S14)', async () => {
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
        output: [{ role: 'assistant', content: '正在读取项目' }],
      }),
    ])
    await settle()
    // No live transcript in the flow: the child page shows it.
    expect(root.querySelector('[data-external-agent-stream]')).toBeNull()
    expect(root.textContent).not.toContain('正在读取项目')
    const row = root.querySelector<HTMLElement>('[data-subagent-row]')!
    expect(row.querySelector('[data-agent-logo="codex"]')).not.toBeNull()
    expect(row.querySelector('[data-agent-identity]')).toBeNull()
    expect(row.querySelector('[data-agent-status]')?.textContent).toContain(
      '运行中',
    )
    const entry = root.querySelector<HTMLAnchorElement>('[data-agent-entry]')
    expect(entry?.textContent).toContain('live work')
    expect(entry?.textContent).toContain('Codex')
    expect(entry?.getAttribute('href')).toBe(
      '/chat/live-external/agents/dlg-one',
    )
    const details = root.querySelector('[data-agent-details]')
    expect(details?.textContent?.trim()).toBe('任务详情')
    expect(details?.closest('a')).toBeNull()
    expect(entry?.querySelector('button')).toBeNull()
    entry?.click()
    await settle()
    expect(router.currentRoute.value.name).toBe('external-agent')
    expect(router.currentRoute.value.params).toEqual({
      sessionId: 'live-external',
      delegationId: 'dlg-one',
    })
  })
  it('keeps a continued external run on its creation name and stable dlg route', async () => {
    setUiPreference('processDisplay', 'expanded')
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
    // One row (UI-S14): no tool row beside it.
    expect(root.querySelector('.tool-row')).toBeNull()
    const row = root.querySelector('[data-subagent-row]')!
    expect(row.textContent).toContain('Codex')
    expect(row.querySelector('[data-agent-status]')?.textContent).toBe(
      '等待回答',
    )
    expect(root.querySelector('[data-agent-details]')?.closest('a')).toBeNull()
  })
  it('resolves native continuation identity and creation title from the shared root tree without a new started event', async () => {
    setUiPreference('processDisplay', 'expanded')
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
    expect(entry?.textContent).toContain('本地')
    expect(entry?.getAttribute('href')).toBe('/chat/sub-existing')
    // One row, one face (UI-S14).
    expect(
      root.querySelectorAll('[data-agent-identity="sub-existing"]'),
    ).toHaveLength(1)
    expect(
      entry.querySelector('[data-agent-identity="sub-existing"]'),
    ).not.toBeNull()
    expect(root.querySelector('.tool-row')).toBeNull()
    expect(
      root.querySelector('[data-subagent-row] [data-agent-status]')
        ?.textContent,
    ).toContain('运行中')
    entry.click()
    expect(opened).toEqual(['sub-existing'])
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
    const kinds = () =>
      [...root.querySelectorAll<HTMLElement>('[data-chat-flow-kind]')].map(
        (el) => el.dataset.chatFlowKind,
      )
    // UI-S03: the finished turn's steps fold into one process row; context
    // injections are hidden until 显示系统步骤.
    // UI-S14: the subagent is a row of its own after the process.
    expect(kinds()).toEqual([
      'user',
      'process',
      'agents',
      'assistant',
      'turnTail',
      'compaction',
    ])
    await openProcess(root)
    expect(kinds()).toEqual([
      'user',
      'process',
      'retry',
      'assistant',
      'tool',
      'tool',
      'tool',
      'agents',
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
    expect(tools).toHaveLength(3)
    const agent = root.querySelector('[data-subagent-row]')!
    expect(agent.textContent).toContain('research')
    expect(agent.textContent).toContain('本地')
    expect(agent.querySelector('[data-agent-status]')?.textContent).toContain(
      '已完成',
    )
    expect(agent.querySelector('[data-agent-summary]')?.textContent).toBe(
      'child found x',
    )
    expect(root.querySelector('[data-subagent-line]')).toBeNull()
    expect(root.textContent).toContain('已压缩 10 条消息')
    expect(root.querySelector('.turn-status')).toBeNull()
  })

  it('routes inspect and open-subagent through its emits', async () => {
    // Inspect is offered only while 显示轨迹 is on (UI-S09).
    setUiPreference('showTrajectory', true)
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
    await openProcess(root)
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

// UI-S14: one row per subagent, a group per step, the status bar's input.
describe('subagent rows (UI-S14)', () => {
  /** One step sends out `ids` in the background; the next step answers. */
  function agentsLog(
    ids: readonly string[],
    backends: Record<string, 'codex' | 'claude-code'> = {},
  ): LogBuilder {
    const log = new LogBuilder()
    log.user('u1', '派几个子智能体')
    log.add('turn/start', { turn: 1 })
    log.add('step/start', { turn: 1, step: 1 })
    log.message(1, 1, [
      { type: 'text', text: '交给几个执笔者。' },
      ...ids.map((id) => ({
        type: 'tool-call',
        id: `call-${id}`,
        name: 'subagent',
        arguments: '{}',
      })),
    ])
    for (const id of ids) {
      const backend = backends[id]
      log.call(1, 1, `call-${id}`, 'subagent', {
        description: `写 ${id}`,
        prompt: 'p',
        run_in_background: true,
        ...(backend ? { backend } : {}),
      })
      if (backend)
        log.add('delegation/projection', {
          event: 'delegation_run_changed',
          delegation_id: id,
          run_id: `run-${id}`,
          current_run_id: `run-${id}`,
          parent_call_id: `call-${id}`,
          backend,
          journal_seq: 1,
          task: { description: `写 ${id}`, status: 'running' },
        })
      else
        log.add('subagent/started', {
          subagentId: id,
          description: `写 ${id}`,
          mode: 'spawn',
          background: true,
          callId: `call-${id}`,
        })
      log.result(1, 1, `call-${id}`, `started ${id}`, {
        meta: { kind: 'continuable', subagentId: id },
      })
    }
    log.add('step/end', { turn: 1, step: 1 })
    log.add('step/start', { turn: 1, step: 2 })
    log.message(1, 2, [{ type: 'text', text: '都在写。' }])
    log.add('step/end', { turn: 1, step: 2 })
    log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return log
  }
  const done = (log: LogBuilder, id: string, text = 'ok') =>
    log.add('subagent/settled', {
      subagentId: id,
      stopReason: 'completed',
      text,
    })

  it('1 · one row per subagent, its face shown once', async () => {
    const log = loadKernelLog()
    const root = mount('kernel', [
      { id: 'kernel', events: [...log.root.events] },
    ])
    await settle()
    const rows = root.querySelectorAll('[data-subagent-row]')
    expect(rows).toHaveLength(1)
    expect(root.querySelectorAll('[data-agent-identity]')).toHaveLength(1)
    expect(rows[0]!.querySelectorAll('[data-agent-identity]')).toHaveLength(1)
    expect(rows[0]!.querySelector('[data-agent-entry]')).not.toBeNull()
    expect(root.querySelector('.tool-row[data-tool="subagent"]')).toBeNull()
    expect(root.querySelector('[data-subagent-line]')).toBeNull()
  })

  it('2 · the summary line appears only after the run ends', async () => {
    const log = agentsLog(['sub-a'])
    const root = mount('s', [{ id: 's', events: [...log.events] }])
    await settle()
    const status = () =>
      root.querySelector('[data-subagent-row] [data-agent-status]')
        ?.textContent ?? ''
    expect(status()).toContain('后台运行中')
    expect(root.querySelector('[data-agent-summary]')).toBeNull()
    fixture!.emit('s', [done(log, 'sub-a', '## 第一章\n写完了，1100 字。')])
    await settle()
    expect(status()).toMatch(/^已完成 · 用时/)
    expect(root.querySelector('[data-agent-summary]')?.textContent).toBe(
      '第一章 写完了，1100 字。',
    )
  })

  it('3 · a step’s subagents form one group: open while running, folded when all end, then the reader decides', async () => {
    const log = agentsLog(['sub-a', 'sub-b', 'sub-c'])
    const root = mount('g', [{ id: 'g', events: [...log.events] }])
    await settle()
    const head = () =>
      root.querySelector<HTMLElement>('[data-subagent-group-head]')!
    const listed = () =>
      root.querySelectorAll('[data-subagent-group] [data-subagent-row]')
    expect(root.querySelectorAll('[data-subagent-group]')).toHaveLength(1)
    expect(root.querySelectorAll('[data-subagent-row]')).toHaveLength(3)
    expect(head().textContent).toContain('派出 3 个子智能体')
    expect(head().textContent).toContain('3 运行中')
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(listed()).toHaveLength(3)
    fixture!.emit('g', [done(log, 'sub-a'), done(log, 'sub-b')])
    await settle()
    expect(head().textContent).toContain('1 运行中 · 2 完成')
    expect(head().getAttribute('aria-expanded')).toBe('true')
    fixture!.emit('g', [done(log, 'sub-c')])
    await settle()
    expect(head().textContent).toContain('3 个子智能体')
    expect(head().textContent).not.toContain('派出')
    expect(head().textContent).toMatch(/3 完成 · 用时 \d/)
    expect(head().getAttribute('aria-expanded')).toBe('false')
    expect(listed()).toHaveLength(0)
    head().click()
    await settle()
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(listed()).toHaveLength(3)
    // In a group the report's opening is the row's tooltip (the design).
    expect(root.querySelector('[data-agent-summary]')).toBeNull()
    expect(listed()[0]!.getAttribute('title')).toBe('ok')
  })

  it('3 · a group folded by the reader while it ran stays folded; Enter and Space toggle it', async () => {
    const log = agentsLog(['sub-a', 'sub-b'])
    const root = mount('k', [{ id: 'k', events: [...log.events] }])
    await settle()
    const head = () =>
      root.querySelector<HTMLElement>('[data-subagent-group-head]')!
    expect(head().getAttribute('tabindex')).toBe('0')
    expect(head().getAttribute('role')).toBe('button')
    head().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    expect(head().getAttribute('aria-expanded')).toBe('false')
    fixture!.emit('k', [done(log, 'sub-a'), done(log, 'sub-b')])
    await settle()
    expect(head().getAttribute('aria-expanded')).toBe('false')
    head().dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    await settle()
    expect(head().getAttribute('aria-expanded')).toBe('true')
  })

  it('4 · Claude Code and Codex show their own logos, in the rows and the group head', async () => {
    const log = agentsLog(['dlg-cc', 'dlg-cx', 'sub-a'], {
      'dlg-cc': 'claude-code',
      'dlg-cx': 'codex',
    })
    const root = mount('l', [{ id: 'l', events: [...log.events] }])
    await settle()
    const rows = [...root.querySelectorAll<HTMLElement>('[data-subagent-row]')]
    expect(rows).toHaveLength(3)
    expect(
      rows[0]!.querySelector('[data-agent-logo="claude-code"]'),
    ).not.toBeNull()
    expect(rows[0]!.textContent).toContain('Claude Code')
    expect(rows[1]!.querySelector('[data-agent-logo="codex"]')).not.toBeNull()
    expect(rows[1]!.textContent).toContain('Codex')
    expect(
      rows[2]!.querySelector('[data-agent-identity="sub-a"]'),
    ).not.toBeNull()
    expect(rows[2]!.querySelector('[data-agent-logo]')).toBeNull()
    const faces = root.querySelector('[data-subagent-group-head]')!
    expect(
      faces.querySelector('[data-agent-logo="claude-code"]'),
    ).not.toBeNull()
    expect(faces.querySelector('[data-agent-logo="codex"]')).not.toBeNull()
  })

  it('7 · a row opens the child the way the entry did', async () => {
    const opened: string[] = []
    const log = agentsLog(['sub-a', 'dlg-x'], { 'dlg-x': 'codex' })
    const root = mount('o', [{ id: 'o', events: [...log.events] }], {
      openSubagent: (id) => opened.push(id),
    })
    await settle()
    const [local, external] = [
      ...root.querySelectorAll<HTMLAnchorElement>('[data-agent-entry]'),
    ]
    expect(local!.getAttribute('href')).toBe('/chat/sub-a')
    expect(external!.getAttribute('href')).toBe('/chat/o/agents/dlg-x')
    // A modified click is left to the browser.
    const modified = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    })
    local!.dispatchEvent(modified)
    expect(modified.defaultPrevented).toBe(false)
    expect(opened).toEqual([])
    local!.click()
    expect(opened).toEqual(['sub-a'])
    external!.click()
    await settle()
    expect(router.currentRoute.value.name).toBe('external-agent')
    expect(router.currentRoute.value.params).toEqual({
      sessionId: 'o',
      delegationId: 'dlg-x',
    })
    // The summary and the status are part of the same click target.
    expect(
      root
        .querySelector('[data-subagent-row] [data-agent-status]')
        ?.closest('[data-subagent-row]'),
    ).not.toBeNull()
  })

  it('6 · revealAgents scrolls to the group and lights it up', async () => {
    const log = agentsLog(['sub-a', 'sub-b'])
    const root = mount('r', [{ id: 'r', events: [...log.events] }])
    await settle()
    const seat = root.querySelector<HTMLElement>('[data-agents-row]')!
    const id = seat.dataset.chatAnchorKey!
    expect(id).toMatch(/^agents:/)
    expect(timeline!.revealAgents(id)).toBe(true)
    await settle()
    expect(
      root.querySelector('[data-agents-row]')?.hasAttribute('data-highlight'),
    ).toBe(true)
    expect(timeline!.revealAgents('agents:missing')).toBe(false)
  })

  it('5 · reports its groups and which of them are on screen', async () => {
    type Callback = (entries: Array<Partial<IntersectionObserverEntry>>) => void
    const observers: Array<{ callback: Callback; targets: Element[] }> = []
    const Native = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = class {
      targets: Element[] = []
      constructor(readonly callback: Callback) {
        observers.push(this)
      }
      observe(target: Element): void {
        this.targets.push(target)
      }
      unobserve(target: Element): void {
        this.targets = this.targets.filter((item) => item !== target)
      }
      disconnect(): void {
        this.targets = []
      }
      takeRecords(): [] {
        return []
      }
    } as unknown as typeof IntersectionObserver
    try {
      const reports: Array<{
        groups: Array<{ id: string; members: string[] }>
        visible: string[]
      }> = []
      const log = agentsLog(['sub-a', 'sub-b'])
      const root = mount(
        'v',
        [{ id: 'v', events: [...log.events] }],
        {},
        undefined,
        { onAgents: (state: (typeof reports)[number]) => reports.push(state) },
      )
      await settle()
      const seat = root.querySelector<HTMLElement>('[data-agents-row]')!
      const id = seat.dataset.chatAnchorKey!
      expect(reports.at(-1)?.groups).toEqual([
        {
          id,
          members: [
            conversationContextKey('tool', 'call-sub-a'),
            conversationContextKey('tool', 'call-sub-b'),
          ],
        },
      ])
      expect(reports.at(-1)?.visible).toEqual([])
      const observer = observers.find((item) => item.targets.includes(seat))!
      expect(observer).toBeDefined()
      observer.callback([{ target: seat, isIntersecting: true }])
      await settle()
      expect(reports.at(-1)?.visible).toEqual([id])
      observer.callback([{ target: seat, isIntersecting: false }])
      await settle()
      expect(reports.at(-1)?.visible).toEqual([])
    } finally {
      globalThis.IntersectionObserver = Native
    }
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
    // UI-S03: the running process is one live line, the status line itself.
    const live = root.querySelector('[data-process-group][data-live]')
    expect(live?.textContent).toContain('正在读取 store.ts')
    expect(root.querySelector('.turn-status')).toBeNull()
    await openProcess(root)
    expect(root.querySelector('.reasoning')).not.toBeNull()
    expect(root.textContent).toContain('会话持久化分三层')
    expect(
      root
        .querySelector('.tool-row[data-call-id="live_read"]')
        ?.getAttribute('data-state'),
    ).toBe('running')
  })

  it('renders the showcase turn with its tail and final markdown', async () => {
    const scenario = showcaseScenario(Date.now())
    const root = mount('showcase', scenario.sessions)
    await settle()
    expect(root.querySelector('[data-turn-tail]')).not.toBeNull()
    expect(root.querySelector('.ds-md table')).not.toBeNull()
    expect(root.querySelector('.ds-md .ds-code')).not.toBeNull()
    await openProcess(root)
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
    // UI-S13: the files card sits between the answer and its footer.
    expect(
      closingAssistantKeys(
        ['a', 'f', 'b'],
        new Map([
          ['a', { kind: 'assistant' }],
          ['f', { kind: 'turnFiles' }],
          ['b', { kind: 'turnTail' }],
        ]) as never,
      ),
    ).toEqual(new Set(['a']))
  })
})
