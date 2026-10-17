// @vitest-environment jsdom
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  reactive,
  ref,
  KeepAlive,
  type App,
} from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ExternalAgentConversation from './ExternalAgentConversation.vue'
import { useSession } from '../../composables/useSession'
const bridge = vi.hoisted(() => ({
  invokeCore: vi.fn(),
  push: vi.fn(),
  off: vi.fn(),
  listener: (_e: unknown) => {},
}))
const route = reactive({
  name: 'external-agent',
  params: { sessionId: 'root', delegationId: 'dlg-one' },
})
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: bridge.push }),
}))
vi.mock('../../api/backend', () => ({
  invokeCore: bridge.invokeCore,
  onCoreEvent: (listener: (e: unknown) => void) => {
    bridge.listener = listener
    return bridge.off
  },
  openExternal: vi.fn(),
  revealReference: vi.fn(),
}))
vi.mock('./parts/ConversationMarkdown.vue', () => ({
  default: defineComponent({
    props: ['text'],
    setup: (props) => () => h('p', props.text),
  }),
}))
vi.mock('vue-virtual-scroller', () => ({
  DynamicScroller: defineComponent({
    props: ['items'],
    setup(props, { slots, expose }) {
      expose({ scrollToBottom: () => {} })
      return () =>
        h('div', [
          slots.before?.(),
          ...props.items.map((item: unknown, index: number) =>
            slots.default?.({ item, index, active: true }),
          ),
          slots.after?.(),
        ])
    },
  }),
  DynamicScrollerItem: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h('div', slots.default?.()),
  }),
}))
let app: App | undefined, root: HTMLDivElement
let currentRun = 'dgr-one',
  phase = 'running'
let stopResolve: (() => void) | undefined
let archived = false,
  rootExists = true
async function settle() {
  for (let i = 0; i < 80; i++) await Promise.resolve()
  await nextTick()
  // A real click happens after listeners attach. Vue capture/bubble timestamp
  // guards reject synthetic clicks in the same millisecond as mounting.
  await new Promise((resolve) => setTimeout(resolve, 1))
}
async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(ExternalAgentConversation)
  app.mount(root)
  await settle()
  return root
}
beforeEach(() => {
  currentRun = 'dgr-one'
  archived = false
  rootExists = true
  useSession().sessions.value = [{ id: 'root', title: 'Root' } as never]
  phase = 'running'
  stopResolve = undefined
  route.name = 'external-agent'
  route.params = { sessionId: 'root', delegationId: 'dlg-one' }
  bridge.invokeCore.mockImplementation(
    async (key: string, input: Record<string, unknown>) => {
      if (key === 'sessions.list')
        return rootExists
          ? [{ id: 'root', archived_at: archived ? '2026-10-17' : null }]
          : []
      if (key === 'delegations.get')
        return {
          record: {
            id: input.id,
            backend: 'codex',
            owner: { rootSessionId: 'root', parentAgentId: 'sub-parent' },
            currentRunId: currentRun,
            startSpec: { description: '检验图片' },
          },
          runs: { [currentRun]: { id: currentRun, phase } },
        }
      if (key === 'agents.list')
        return {
          agents: [
            {
              id: 'sub-parent',
              rootSessionId: 'root',
              kind: 'internal',
              title: '父任务',
              backend: 'internal',
              parentAgentId: 'root',
            },
            {
              id: input.rootSessionIds ? route.params.delegationId : 'dlg-one',
              rootSessionId: 'root',
              kind: 'external',
              title: '检验图片',
              backend: 'codex',
              phase: phase === 'completed' ? 'completed' : 'running',
              parentAgentId: 'sub-parent',
            },
          ],
        }
      if (key === 'delegations.history')
        return {
          entries: input.after
            ? []
            : [
                {
                  id: 'entry-one',
                  runId: currentRun,
                  type: 'text',
                  text: '公开结果',
                },
              ],
          before: 'one',
          after: 'one',
          hasBefore: false,
          hasAfter: false,
        }
      if (key === 'delegations.interrupt')
        return new Promise<void>((resolve) => {
          stopResolve = resolve
        })
      throw new Error('unexpected operation: ' + key)
    },
  )
})
afterEach(() => {
  app?.unmount()
  root?.remove()
  vi.clearAllMocks()
})
it('renders canonical title, public readonly output and actual ancestry; return actions never dispatch', async () => {
  const dom = await mount()
  expect(dom.textContent).toContain('检验图片')
  expect(dom.textContent).toContain('父任务')
  expect(dom.textContent).toContain('公开结果')
  expect(dom.querySelector('textarea,input,select')).toBeNull()
  const buttons = [...dom.querySelectorAll<HTMLButtonElement>('button')]
  buttons.find((b) => b.textContent === '返回父智能体')!.click()
  await settle()
  expect(bridge.push).toHaveBeenLastCalledWith({
    name: 'chat',
    params: { sessionId: 'sub-parent' },
  })
  buttons.find((b) => b.textContent?.includes('返回主会话继续派工'))!.click()
  await settle()
  expect(bridge.push).toHaveBeenLastCalledWith({
    name: 'chat',
    params: { sessionId: 'root' },
  })
  expect(
    bridge.invokeCore.mock.calls.every(([key]) =>
      [
        'sessions.list',
        'delegations.history',
        'delegations.get',
        'agents.list',
      ].includes(key),
    ),
  ).toBe(true)
})
it('updates one public tool activity on live completion, retaining its name and both details without visible protocol IDs', async () => {
  let completed = false
  const original = bridge.invokeCore.getMockImplementation()!
  bridge.invokeCore.mockImplementation(
    (key: string, input: Record<string, unknown>) => {
      if (key !== 'delegations.history') return original(key, input)
      return Promise.resolve({
        entries: !input.after
          ? [
              {
                id: 'start',
                runId: currentRun,
                type: 'tool',
                toolId: 'call_read',
                name: 'Read',
                status: 'running',
                text: '读取公开文件',
              },
            ]
          : completed
            ? [
                {
                  id: 'finish',
                  runId: currentRun,
                  type: 'tool',
                  toolId: 'call_read',
                  status: 'completed',
                  text: '读取完成',
                },
              ]
            : [],
        before: 'start',
        after: completed ? 'finish' : 'start',
        hasBefore: false,
        hasAfter: false,
      })
    },
  )
  const dom = await mount()
  const initial = dom.querySelector('[data-entry-type="tool"]')!
  const key = initial.getAttribute('data-entry-id')
  const initialText = initial.textContent
  completed = true
  bridge.listener({
    event: 'delegation_run_changed',
    session_id: 'root',
    delegation_id: 'dlg-one',
  })
  await settle()
  const tools = dom.querySelectorAll('[data-entry-type="tool"]')
  expect(tools).toHaveLength(1)
  expect(initialText).toContain('Read · 运行中')
  expect(tools[0]!.getAttribute('data-entry-id')).toBe(key)
  expect(tools[0]!.getAttribute('data-tool-id')).toBe('call_read')
  expect(tools[0]!.getAttribute('data-run-id')).toBe('dgr-one')
  expect(tools[0]!.textContent).toContain('Read · 已完成')
  expect(tools[0]!.textContent).toContain('读取公开文件')
  expect(tools[0]!.textContent).toContain('读取完成')
  expect(tools[0]!.textContent).not.toContain('运行中')
  expect(dom.textContent).not.toContain('call_read')
  expect(
    bridge.invokeCore.mock.calls
      .filter(([key]) => key === 'delegations.history')
      .at(-1)?.[1],
  ).toEqual({ id: 'dlg-one', sessionId: 'root', after: 'start' })
})
it('captures stop run and owner and stays stopping until durable state confirms, without stopping the next run', async () => {
  const dom = await mount()
  dom.querySelector<HTMLButtonElement>('[data-stop-child]')!.click()
  await settle()
  expect(bridge.invokeCore).toHaveBeenCalledWith('delegations.interrupt', {
    id: 'dlg-one',
    runId: 'dgr-one',
    sessionId: 'root',
  })
  stopResolve!()
  await settle()
  expect(dom.textContent).toContain('正在停止')
  expect(
    dom.querySelector<HTMLButtonElement>('[data-stop-child]')!.disabled,
  ).toBe(true)
  currentRun = 'dgr-next'
  bridge.listener({
    event: 'delegation_run_changed',
    session_id: 'root',
    delegation_id: 'dlg-one',
  })
  await settle()
  expect(
    dom.querySelector<HTMLButtonElement>('[data-stop-child]')!.disabled,
  ).toBe(false)
  expect(
    bridge.invokeCore.mock.calls.filter(
      ([key]) => key === 'delegations.interrupt',
    ),
  ).toHaveLength(1)
})
it('unsubscribes old routes and fences a pending stop when switching children', async () => {
  const dom = await mount()
  dom.querySelector<HTMLButtonElement>('[data-stop-child]')!.click()
  await settle()
  route.params = { sessionId: 'root', delegationId: 'dlg-two' }
  await settle()
  expect(bridge.off).toHaveBeenCalledTimes(1)
  stopResolve!()
  await settle()
  expect(
    dom.querySelector<HTMLButtonElement>('[data-stop-child]')!.disabled,
  ).toBe(false)
  expect(
    bridge.invokeCore.mock.calls.filter(
      ([key]) => key === 'delegations.interrupt',
    ),
  ).toHaveLength(1)
})

it('disposes a KeepAlive child page when returning to the root without reading an empty delegation', async () => {
  const visible = ref(true)
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(KeepAlive, null, {
        default: () =>
          visible.value ? h(ExternalAgentConversation) : h('div'),
      }),
  })
  app.mount(root)
  await settle()
  const calls = bridge.invokeCore.mock.calls.length
  visible.value = false
  route.name = 'chat'
  route.params = { sessionId: 'root', delegationId: '' }
  await settle()
  expect(bridge.off).toHaveBeenCalledTimes(1)
  expect(bridge.invokeCore.mock.calls).toHaveLength(calls)
  route.name = 'external-agent'
  route.params = { sessionId: 'root', delegationId: 'dlg-one' }
  visible.value = true
  await settle()
  expect(bridge.invokeCore.mock.calls.length).toBeGreaterThan(calls)
})
it('retains a pending stop when reopening the same KeepAlive child before the runtime confirms it', async () => {
  const visible = ref(true)
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(KeepAlive, null, {
        default: () =>
          visible.value ? h(ExternalAgentConversation) : h('div'),
      }),
  })
  app.mount(root)
  await settle()
  root.querySelector<HTMLButtonElement>('[data-stop-child]')!.click()
  await settle()
  visible.value = false
  route.name = 'chat'
  route.params = { sessionId: 'root', delegationId: '' }
  await settle()
  route.name = 'external-agent'
  route.params = { sessionId: 'root', delegationId: 'dlg-one' }
  visible.value = true
  await settle()
  expect(
    root.querySelector<HTMLButtonElement>('[data-stop-child]')!.disabled,
  ).toBe(true)
  stopResolve!()
  await settle()
  phase = 'completed'
  bridge.listener({
    event: 'delegation_run_changed',
    session_id: 'root',
    delegation_id: 'dlg-one',
  })
  await settle()
  expect(root.querySelector('[data-stop-child]')).toBeNull()
})
it('fences a delayed older-page completion after switching to a reused child scroller', async () => {
  const original = bridge.invokeCore.getMockImplementation()!
  let finishOld!: (page: unknown) => void, finishNew!: (page: unknown) => void
  bridge.invokeCore.mockImplementation(
    (key: string, input: Record<string, unknown>) => {
      if (key === 'delegations.history' && input.before)
        return new Promise((resolve) => {
          if (input.id === 'dlg-one') finishOld = resolve
          else finishNew = resolve
        })
      if (key === 'delegations.history')
        return Promise.resolve({
          entries: input.after
            ? []
            : [
                {
                  id: 'first',
                  runId: currentRun,
                  type: 'text',
                  text: `first ${input.id}`,
                },
              ],
          before: 'first',
          after: 'first',
          hasBefore: true,
          hasAfter: false,
        })
      return original(key, input)
    },
  )
  const dom = await mount()
  const timeline = dom.querySelector<HTMLElement>('.child-timeline')!
  Object.defineProperty(timeline, 'scrollHeight', {
    configurable: true,
    value: 500,
  })
  timeline.scrollTop = 50
  const olderButton = () =>
    [...dom.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      /加载更早记录|正在读取…/.test(b.textContent ?? ''),
    )!
  await vi.waitFor(() => expect(olderButton()?.disabled).toBe(false))
  olderButton().click()
  await vi.waitFor(() => {
    expect(typeof finishOld).toBe('function')
    expect(olderButton().disabled).toBe(true)
  })
  route.params = { sessionId: 'root', delegationId: 'dlg-two' }
  await vi.waitFor(() => {
    expect(dom.textContent).toContain('first dlg-two')
    expect(olderButton()?.disabled).toBe(false)
  })
  timeline.scrollTop = 25
  Object.defineProperty(timeline, 'scrollHeight', {
    configurable: true,
    value: 900,
  })
  olderButton().click()
  await vi.waitFor(() => {
    expect(typeof finishNew).toBe('function')
    expect(olderButton().disabled).toBe(true)
  })
  finishOld({
    entries: [],
    before: 'first',
    after: 'first',
    hasBefore: false,
    hasAfter: false,
  })
  await settle()
  expect(timeline.scrollTop).toBe(25)
  expect(olderButton().disabled).toBe(true)
  finishNew({
    entries: [],
    before: 'first',
    after: 'first',
    hasBefore: false,
    hasAfter: false,
  })
  await vi.waitFor(() => expect(dom.querySelector('.child-more')).toBeNull())
})

function overrideRead(key: string, result: () => unknown) {
  const original = bridge.invokeCore.getMockImplementation()!
  bridge.invokeCore.mockImplementation(
    (operation: string, input: Record<string, unknown>) =>
      operation === key
        ? Promise.resolve().then(result)
        : original(operation, input),
  )
}
it('distinguishes pending history from a valid conversation with no public output', async () => {
  let finish!: (value: unknown) => void
  overrideRead(
    'delegations.history',
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const dom = await mount()
  expect(dom.textContent).toContain('正在读取子智能体对话')
  expect(dom.textContent).not.toContain('尚无公开输出')
  finish({
    entries: [],
    before: null,
    after: null,
    hasBefore: false,
    hasAfter: false,
  })
  await settle()
  expect(dom.textContent).toContain('尚无公开输出')
})
it('opens an archived direct route as historical output without activation or control actions', async () => {
  archived = true
  const dom = await mount()
  expect(dom.textContent).toContain('主会话已归档')
  expect(dom.textContent).toContain('公开结果')
  expect(dom.querySelector('[data-stop-child]')).toBeNull()
  expect(
    [...dom.querySelectorAll('button')].some((b) =>
      b.textContent?.includes('继续派工'),
    ),
  ).toBe(false)
  expect(dom.textContent).not.toContain('返回父智能体')
  for (const button of dom.querySelectorAll<HTMLButtonElement>('button'))
    button.click()
  await settle()
  expect(bridge.push).not.toHaveBeenCalled()
  expect(
    bridge.invokeCore.mock.calls.every(([key]) =>
      [
        'sessions.list',
        'delegations.history',
        'delegations.get',
        'agents.list',
      ].includes(key),
    ),
  ).toBe(true)
})
it('updates an open viewer after local archive even without a running child event', async () => {
  const dom = await mount()
  archived = true
  useSession().sessions.value = []
  await settle()
  expect(dom.textContent).toContain('主会话已归档')
  expect(dom.textContent).toContain('公开结果')
  expect(dom.querySelector('[data-stop-child]')).toBeNull()
  expect(
    [...dom.querySelectorAll('button')].some((b) =>
      b.textContent?.includes('继续派工'),
    ),
  ).toBe(false)
})
it('does not read children of a missing root or label unavailable history as empty', async () => {
  rootExists = false
  const dom = await mount()
  expect(dom.textContent).toContain('主会话不存在')
  expect(dom.textContent).not.toContain('正在读取')
  expect(dom.textContent).not.toContain('尚无公开输出')
  expect(
    bridge.invokeCore.mock.calls.every(([key]) => key === 'sessions.list'),
  ).toBe(true)
})
it.each([
  ['DELEGATION_NOT_FOUND', '子智能体不存在'],
  ['PERMISSION_DENIED', '子智能体不可读取'],
  ['TRANSCRIPT_CORRUPT', '公开记录损坏'],
  ['INTERNAL_ERROR', '暂时无法读取'],
])('renders %s as an explicit unavailable state', async (code, message) => {
  overrideRead('delegations.get', () => {
    throw Object.assign(new Error('safe IPC error'), { code })
  })
  const dom = await mount()
  expect(dom.textContent).toContain(message)
  expect(dom.textContent).not.toContain('正在读取')
  expect(dom.textContent).not.toContain('尚无公开输出')
  expect(dom.querySelector('[data-stop-child]')).toBeNull()
  expect(
    [...dom.querySelectorAll('button')].some((b) =>
      b.textContent?.includes('重试'),
    ),
  ).toBe(code === 'INTERNAL_ERROR')
})
it('can retry a transient read error and restore a valid timeline', async () => {
  const original = bridge.invokeCore.getMockImplementation()!
  let failed = true
  bridge.invokeCore.mockImplementation(
    (key: string, input: Record<string, unknown>) => {
      if (key === 'delegations.get' && failed)
        return Promise.reject(new Error('temporary'))
      return original(key, input)
    },
  )
  const dom = await mount()
  expect(dom.textContent).toContain('暂时无法读取')
  failed = false
  ;[...dom.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.includes('重试'))!
    .click()
  await settle()
  expect(dom.textContent).toContain('公开结果')
  expect(dom.textContent).not.toContain('暂时无法读取')
})
it.each(['missing', 'foreign', 'conflicting', 'self-cycle', 'cycle'])(
  'keeps actual %s parent evidence without inventing a root path or navigating it',
  async (kind) => {
    const child = {
      id: 'dlg-one',
      kind: 'external',
      backend: 'codex',
      title: '检验图片',
      phase: 'running',
      rootSessionId: 'root',
      parentAgentId: kind === 'self-cycle' ? 'dlg-one' : 'sub-parent',
      ...(kind === 'foreign' ? { unavailable: 'foreign_parent' } : {}),
      ...(kind === 'conflicting' ? { unavailable: 'conflicting_parent' } : {}),
    }
    const parent = {
      id: 'sub-parent',
      kind: 'internal',
      backend: 'internal',
      title: '父任务',
      rootSessionId: kind === 'foreign' ? 'other-root' : 'root',
      parentAgentId: kind === 'cycle' ? 'dlg-one' : 'root',
    }
    overrideRead('agents.list', () => ({
      agents:
        kind === 'missing' || kind === 'self-cycle' ? [child] : [child, parent],
    }))
    const dom = await mount()
    const path = dom.querySelector('nav')!
    expect(path.textContent).not.toContain('主会话')
    expect(path.textContent).toContain(
      kind.includes('cycle') ? '父级循环' : '父级不可用',
    )
    expect(path.textContent).toContain(child.parentAgentId)
    expect(dom.textContent).not.toContain('返回父智能体')
    expect(path.querySelector('button')).toBeNull()
    ;[...dom.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('返回主会话继续派工'))!
      .click()
    await settle()
    expect(bridge.push).toHaveBeenLastCalledWith({
      name: 'chat',
      params: { sessionId: 'root' },
    })
  },
)
it('routes a valid external parent under the same owning root', async () => {
  overrideRead('agents.list', () => ({
    agents: [
      {
        id: 'dlg-parent',
        kind: 'external',
        backend: 'claude-code',
        title: '外部父任务',
        rootSessionId: 'root',
        parentAgentId: 'root',
      },
      {
        id: 'dlg-one',
        kind: 'external',
        backend: 'codex',
        title: '检验图片',
        phase: 'running',
        rootSessionId: 'root',
        parentAgentId: 'dlg-parent',
      },
    ],
  }))
  const dom = await mount()
  expect(dom.querySelector('nav')?.textContent).toContain('主会话')
  expect(dom.querySelector('nav')?.textContent).toContain('外部父任务')
  ;[...dom.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent === '返回父智能体')!
    .click()
  await settle()
  expect(bridge.push).toHaveBeenLastCalledWith({
    name: 'external-agent',
    params: { sessionId: 'root', delegationId: 'dlg-parent' },
  })
})

it.each(['missing_public_log', 'corrupt_public_log'])(
  'shows %s diagnostic on retained history, including a catch-up refresh',
  async (reason) => {
    let unavailable: unknown[] = []
    overrideRead('delegations.history', () => ({
      entries: [],
      before: null,
      after: null,
      hasBefore: false,
      hasAfter: false,
      unavailable,
    }))
    const dom = await mount()
    expect(dom.textContent).toContain('尚无公开输出')
    unavailable = [{ runId: 'dgr-one', reason }]
    bridge.listener({ event: 'agent_tree_changed', rootSessionId: 'root' })
    await settle()
    expect(dom.textContent).toContain(
      reason === 'missing_public_log' ? '公开记录缺失' : '公开记录损坏',
    )
    expect(dom.textContent).toContain('dgr-one')
    expect(dom.textContent).not.toContain('尚无公开输出')
  },
)
it('observes a backend archive while focused without repeatedly reading unchanged history', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const dom = await mount()
    const initialHistoryReads = bridge.invokeCore.mock.calls.filter(
      ([key]) => key === 'delegations.history',
    ).length
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(
      bridge.invokeCore.mock.calls.filter(
        ([key]) => key === 'delegations.history',
      ),
    ).toHaveLength(initialHistoryReads)
    archived = true
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(dom.textContent).toContain('主会话已归档')
    expect(dom.textContent).toContain('公开结果')
    expect(dom.querySelector('[data-stop-child]')).toBeNull()
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    const hiddenCalls = bridge.invokeCore.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(bridge.invokeCore.mock.calls).toHaveLength(hiddenCalls)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(bridge.invokeCore.mock.calls.length).toBeGreaterThan(hiddenCalls)
    visibility.mockRestore()
    app!.unmount()
    app = undefined
    const calls = bridge.invokeCore.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(bridge.invokeCore.mock.calls).toHaveLength(calls)
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
