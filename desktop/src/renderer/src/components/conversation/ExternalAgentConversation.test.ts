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
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await nextTick()
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
  phase = 'running'
  stopResolve = undefined
  route.name = 'external-agent'
  route.params = { sessionId: 'root', delegationId: 'dlg-one' }
  bridge.invokeCore.mockImplementation(
    async (key: string, input: Record<string, unknown>) => {
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
              title: '父任务',
              backend: 'internal',
              parentAgentId: 'root',
            },
            {
              id: 'dlg-one',
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
  expect(bridge.push).toHaveBeenLastCalledWith({
    name: 'chat',
    params: { sessionId: 'sub-parent' },
  })
  buttons.find((b) => b.textContent?.includes('返回主会话继续派工'))!.click()
  expect(bridge.push).toHaveBeenLastCalledWith({
    name: 'chat',
    params: { sessionId: 'root' },
  })
  expect(
    bridge.invokeCore.mock.calls.every(([key]) =>
      ['delegations.history', 'delegations.get', 'agents.list'].includes(key),
    ),
  ).toBe(true)
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
