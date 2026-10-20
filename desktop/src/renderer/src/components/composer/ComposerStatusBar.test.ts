// @vitest-environment jsdom
/**
 * UI-S04: the docks above the composer (changes pill, todo, goal, queue)
 * are one single-line status bar. It is not there when nothing has
 * anything to say; clicking it opens a popover with a section for each:
 * changes (to 审查), todos, the goal (pause / edit / clear) and the queue
 * (send / edit / discard, including KRN-02's 「上一轮失败」 messages).
 */
import { createApp, h, nextTick, reactive, shallowRef, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedPromptItem, RuntimeGoalView, TodoItem } from '../../types'
import { answerConfirmsForTest } from '../ui/confirm'
import type { WorkspaceSnapshot } from '../workspace/workspaceTypes'
import ComposerStatusBar from './ComposerStatusBar.vue'

const workspace = vi.hoisted(() => ({
  snapshot: null as unknown as { value: WorkspaceSnapshot | null },
  requests: [] as unknown[],
}))
workspace.snapshot = shallowRef<WorkspaceSnapshot | null>(null)

vi.mock('../workspace/useWorkspaceSnapshot', () => ({
  useWorkspaceSnapshot: () => ({ snapshot: workspace.snapshot }),
}))
vi.mock('../workspace/workspaceState', () => ({
  requestWorkspace: (request: unknown) => {
    workspace.requests.push(request)
    return request
  },
}))

const todos: TodoItem[] = [
  { id: 1, content: '读取规格', status: 'completed' },
  { id: 2, content: '实现外壳', status: 'completed' },
  { id: 3, content: '重做输入框', status: 'in_progress' },
  { id: 4, content: '截图验收', status: 'pending' },
]

function goal(phase = 'active'): RuntimeGoalView {
  return {
    id: 'goal-1',
    revision: 1,
    objective: '让输入框更简单',
    phase,
    maxGoalRounds: 8,
    roundsStarted: 2,
    createdAt: Date.now() - 23_000,
    updatedAt: Date.now(),
  }
}

function prompt(overrides: Partial<QueuedPromptItem> = {}): QueuedPromptItem {
  return {
    id: 'p1',
    turnId: '',
    clientMessageId: 'c1',
    content: 'check the tests',
    delivery: 'queue',
    status: 'queued',
    supportsInterjection: true,
    createdOrder: 0,
    attachmentCount: 0,
    requestedSkillNames: [],
    hasCapabilityRefs: false,
    ...overrides,
  }
}

function changes(files: number, additions: number, deletions: number) {
  workspace.snapshot.value = {
    version: 1,
    sessionId: 'build-1',
    git: {
      repository: { root: '/tmp/project' },
      summary: { changedFiles: files, additions, deletions },
    },
  } as unknown as WorkspaceSnapshot
}

let app: App | null = null
let host: HTMLDivElement | null = null

function mount(overrides: Record<string, unknown> = {}) {
  const props = reactive<Record<string, unknown>>({
    sessionId: 'build-1',
    build: true,
    todos: [],
    goal: null,
    goalActionPending: null,
    queue: [],
    takeover: false,
    onGoalAction: vi.fn(),
    onGoalEdit: vi.fn(),
    onEdit: vi.fn(),
    onInterject: vi.fn(),
    onCancel: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  })
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(ComposerStatusBar, props) })
  app.mount(host)
  return { root: host, props }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function bar(root: HTMLElement): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>('.composer-status-bar')
}

/** The bar's line as read: parts joined by 「 · 」. */
function barText(root: HTMLElement): string {
  return (bar(root)?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

async function expand(root: HTMLElement): Promise<HTMLElement> {
  bar(root)!.click()
  await settle()
  const panel = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="输入框状态"]',
  )
  if (!panel) throw new Error('the status popover did not open')
  return panel
}

function section(panel: HTMLElement, label: string): HTMLElement {
  const found = panel.querySelector<HTMLElement>(
    `section[aria-label="${label}"]`,
  )
  if (!found) throw new Error(`no ${label} section`)
  return found
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found =
    scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === label,
    )
  if (!found) throw new Error(`no button ${label}`)
  return found
}

beforeEach(() => {
  workspace.snapshot.value = null
  workspace.requests.length = 0
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
  answerConfirmsForTest(null)
  document.body.innerHTML = ''
})

describe('the composer status bar', () => {
  it('4 · renders nothing when there is nothing to report', async () => {
    const { root, props } = mount()
    await settle()
    expect(bar(root)).toBeNull()
    expect(root.textContent).toBe('')
    // A clean tree in a Build session, a plain chat: still nothing.
    changes(0, 0, 0)
    await settle()
    expect(bar(root)).toBeNull()
    props.build = false
    changes(3, 18, 4)
    await settle()
    expect(bar(root)).toBeNull()
  })

  it('says everything in one line: changes, todos, goal, queue', async () => {
    changes(3, 18, 4)
    const { root } = mount({
      todos,
      goal: goal('active'),
      queue: [
        prompt({
          status: 'failed-previous',
          holdReason: 'previous-turn-failed',
        }),
      ],
    })
    await settle()
    expect(barText(root)).toBe(
      '3 个文件已更改 +18 −4 · 待办 2/4 · 目标进行中 · 1 条待发送',
    )
    expect(bar(root)!.getAttribute('aria-expanded')).toBe('false')
    // One control, whatever it holds.
    expect(root.querySelectorAll('button')).toHaveLength(1)
  })

  it('keeps only the goal while a takeover card holds the composer seat', async () => {
    changes(3, 18, 4)
    const { root, props } = mount({
      todos,
      goal: goal('active'),
      queue: [prompt()],
      takeover: true,
    })
    await settle()
    expect(barText(root)).toBe('目标进行中')
    props.goal = null
    await settle()
    expect(bar(root)).toBeNull()
  })

  it('5 · expands into sections whose actions work', async () => {
    changes(3, 18, 4)
    const queued = prompt({ id: 'q1', content: '继续补充视觉验收细节' })
    const { root, props } = mount({
      todos,
      goal: goal('active'),
      queue: [queued],
    })
    await settle()
    let panel = await expand(root)
    expect(bar(root)!.getAttribute('aria-expanded')).toBe('true')
    expect(
      [...panel.querySelectorAll('section')].map((item) =>
        item.getAttribute('aria-label'),
      ),
    ).toEqual(['改动', '待办', '目标', '待处理消息队列'])

    // 改动 → 审查 (the popover closes: the workspace opens instead).
    const changed = section(panel, '改动')
    expect(changed.textContent).toContain('3 个文件已更改')
    button(changed, '审查').click()
    await settle()
    expect(workspace.requests).toEqual([{ pane: 'review' }])
    expect(document.querySelector('[aria-label="输入框状态"]')).toBeNull()

    // 待办: every item, the one in progress marked. The other actions
    // leave the popover open.
    panel = await expand(root)
    const todo = section(panel, '待办')
    expect(todo.textContent).toContain('2/4')
    expect(
      [...todo.querySelectorAll('li')].map((item) => [
        item.textContent?.trim(),
        item.getAttribute('data-status'),
      ]),
    ).toEqual([
      ['读取规格', 'completed'],
      ['实现外壳', 'completed'],
      ['重做输入框', 'in_progress'],
      ['截图验收', 'pending'],
    ])

    // 目标: pause; clear asks first (edit: below).
    const goalSection = section(panel, '目标')
    expect(goalSection.textContent).toContain('让输入框更简单')
    expect(goalSection.textContent).toContain('进行中')
    expect(button(goalSection, '编辑 Goal').disabled).toBe(false)
    button(goalSection, '暂停 Goal').click()
    expect(props.onGoalAction).toHaveBeenLastCalledWith('pause')
    answerConfirmsForTest(() => false)
    button(goalSection, '清除 Goal').click()
    await settle()
    expect(props.onGoalAction).toHaveBeenCalledTimes(1)
    answerConfirmsForTest(() => true)
    button(goalSection, '清除 Goal').click()
    await settle()
    expect(props.onGoalAction).toHaveBeenLastCalledWith('cancel')

    // 队列: interject, delete, edit for a queued message.
    const queue = section(panel, '待处理消息队列')
    expect(queue.textContent).toContain('1 条排队中')
    expect(queue.textContent).toContain('继续补充视觉验收细节')
    button(queue, '插入当前执行').click()
    expect(props.onInterject).toHaveBeenCalledWith(queued)
    button(queue, '删除排队消息').click()
    expect(props.onCancel).toHaveBeenCalledWith(queued)
    button(queue, '编辑消息').click()
    expect(props.onEdit).toHaveBeenCalledWith(queued)
  })

  it('edits and resumes a paused goal', async () => {
    const { root, props } = mount({ goal: goal('paused') })
    await settle()
    expect(barText(root)).toBe('目标已暂停')
    const panel = await expand(root)
    const goalSection = section(panel, '目标')
    expect(goalSection.textContent).toContain('Goal 已暂停，可恢复后继续。')
    button(goalSection, '恢复 Goal').click()
    expect(props.onGoalAction).toHaveBeenLastCalledWith('resume')
    button(goalSection, '编辑 Goal').click()
    await settle()
    expect(props.onGoalEdit).toHaveBeenCalledOnce()
  })

  it('6 · sends and discards a message held after 上一轮失败', async () => {
    const held = prompt({
      id: 'h1',
      content: 'check the tests',
      status: 'failed-previous',
      holdReason: 'previous-turn-failed',
    })
    const { root, props } = mount({ queue: [held] })
    await settle()
    expect(barText(root)).toBe('1 条待发送')
    const panel = await expand(root)
    const queue = section(panel, '待处理消息队列')
    expect(queue.textContent).toContain('待发送 · 上一轮失败')
    expect(queue.textContent).toContain('check the tests')
    // A held message is sent or discarded, never interjected.
    expect(queue.querySelector('button[aria-label="插入当前执行"]')).toBeNull()
    button(queue, '发送排队消息').click()
    expect(props.onSend).toHaveBeenCalledWith(held)
    button(queue, '丢弃排队消息').click()
    expect(props.onCancel).toHaveBeenCalledWith(held)
    button(queue, '编辑消息').click()
    expect(props.onEdit).toHaveBeenCalledWith(held)
  })

  it.each([
    ['previous-turn-stopped', '待发送 · 上一轮已停止'],
    ['interrupted', '待发送 · 应用重启前未发出'],
  ] as const)('labels a message held for %s', async (holdReason, label) => {
    const { root } = mount({
      queue: [prompt({ status: 'failed-previous', holdReason })],
    })
    await settle()
    const panel = await expand(root)
    expect(section(panel, '待处理消息队列').textContent).toContain(label)
  })

  it('closes with Escape and gives focus back to the bar', async () => {
    const { root } = mount({ todos })
    await settle()
    await expand(root)
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await settle()
    expect(document.querySelector('[aria-label="输入框状态"]')).toBeNull()
    expect(document.activeElement).toBe(bar(root))
  })
})
