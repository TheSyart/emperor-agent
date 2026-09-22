// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShowcaseLog } from '../conversation/gallery/showcaseLog'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', () => ({
  closePreviewView: vi.fn(),
  onPreviewState: vi.fn(() => () => undefined),
  openPreviewExternal: vi.fn(),
  openPreviewView: vi.fn(async () => undefined),
  previewAction: vi.fn(),
  setPreviewBounds: vi.fn(),
  onTerminalEvent: vi.fn(() => () => undefined),
  onSessionEvents: vi.fn(() => () => undefined),
}))

import DetailsPanel from './DetailsPanel.vue'
import {
  FRAME_STORAGE_KEY,
  frameActions,
  resetFrameStateForTest,
  useFrameState,
} from '../shell/frameState'
import {
  consumeDetailsRequest,
  detailsRequest,
  requestDetails,
} from './detailsState'
import { clearInspectSelection, selectCall } from './inspectState'

const SNAPSHOT = {
  sessionId: 's1',
  capturedAt: 1,
  project: { name: 'demo', path: '/tmp/demo' },
  git: null,
  terminals: [],
  worktrees: { owned: [] },
  gitReceipts: [],
}

/** Raw log of s1: one settled grep call with a JSON result and meta. */
function inspectLog() {
  const log = new ShowcaseLog(1_700_000_000_000)
  log.user('找一下 TODO')
  log.turnStart(0)
  log.toolStep(
    0,
    0,
    [],
    [
      {
        id: 'call_42',
        name: 'grep',
        args: { pattern: 'TODO', path: 'src' },
        result: '{"matches":3}',
        extra: { meta: { total: 3 } },
      },
    ],
  )
  log.turnEnd(0)
  return log.events
}

function fakeCore(operation: string, payload?: Record<string, unknown>) {
  switch (operation) {
    case 'sessions.history': {
      const events = inspectLog()
      return Promise.resolve({
        header: { version: 0, id: 's1', createdAt: 0 },
        events,
        hasMore: false,
        lastSeq: events.at(-1)?.seq ?? -1,
      })
    }
    case 'sessions.watch':
      return Promise.resolve({ watching: [] })
    case 'sidebar.get':
      return Promise.resolve({})
    case 'workspace.snapshot':
      return Promise.resolve(SNAPSHOT)
    case 'tasks.list':
      return Promise.resolve([])
    case 'files.list':
      return Promise.resolve({
        projectRoot: '/tmp/demo',
        relativePath: String(payload?.relativePath ?? ''),
        entries: [],
      })
    case 'files.read':
      return Promise.resolve({
        kind: 'text',
        name: 'a.ts',
        content: 'const a = 1\n',
        truncated: false,
        bytes: 12,
      })
    default:
      return Promise.resolve(null)
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(props: Partial<Record<string, unknown>> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(DetailsPanel, {
    sessionId: 's1',
    projectPath: '/tmp/demo',
    sources: [],
    agentBusy: false,
    refreshKey: 0,
    ...props,
  })
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/chat/:sessionId?',
        name: 'chat',
        component: { render: () => null },
      },
      {
        path: '/chat/:sessionId/trajectory',
        name: 'trajectory',
        component: { render: () => null },
      },
    ],
  })
  app.use(router)
  app.mount(container)
  return container
}

function tabButton(root: HTMLElement, id: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"]`)
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  window.localStorage.removeItem(FRAME_STORAGE_KEY)
  resetFrameStateForTest()
  const pending = detailsRequest().value
  if (pending) consumeDetailsRequest(pending)
  clearInspectSelection()
  core.mockImplementation(fakeCore)
  frameActions.openDetails(useFrameState(), 'environment')
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  core.mockReset()
  vi.unstubAllGlobals()
})

describe('DetailsPanel', () => {
  it('renders the detail tabs bound to frameState and the environment pane', async () => {
    const root = mount()
    await flush()
    const ids = [...root.querySelectorAll<HTMLElement>('[data-tab-id]')].map(
      (el) => el.dataset.tabId,
    )
    expect(ids).toEqual(['inspect', 'git', 'files', 'terminal', 'environment'])
    expect(tabButton(root, 'environment')?.getAttribute('aria-selected')).toBe(
      'true',
    )
    // Snapshot without git: the Git tab is disabled.
    expect(tabButton(root, 'git')?.disabled).toBe(true)
    expect(root.textContent).toContain('Environment')
    expect(core).toHaveBeenCalledWith('workspace.snapshot', { sessionId: 's1' })

    tabButton(root, 'inspect')!.click()
    await flush()
    expect(useFrameState().detailsTab).toBe('inspect')
    expect(root.textContent).toContain(
      '在对话或轨迹中选择一个工具调用以查看详情',
    )
  })

  it('disables project-only tabs without a project', async () => {
    const root = mount({ projectPath: '' })
    await flush()
    expect(tabButton(root, 'files')?.disabled).toBe(true)
    expect(tabButton(root, 'terminal')?.disabled).toBe(true)
    expect(tabButton(root, 'environment')?.disabled).toBe(false)
    expect(core).not.toHaveBeenCalledWith(
      'workspace.snapshot',
      expect.anything(),
    )
  })

  it('close button closes the details column through frameActions', async () => {
    const root = mount()
    await flush()
    root
      .querySelector<HTMLButtonElement>('button[aria-label="关闭详情面板"]')!
      .click()
    expect(useFrameState().details).toBe(0)
  })

  it('requestDetails({ tab: files, file }) opens the file in the Files tab', async () => {
    const root = mount()
    await flush()
    requestDetails({ tab: 'files', file: { path: './src/a.ts', line: 1 } })
    await flush()
    expect(useFrameState().detailsTab).toBe('files')
    expect(core).toHaveBeenCalledWith('files.read', {
      sessionId: 's1',
      relativePath: 'src/a.ts',
    })
    expect(root.querySelector('.file-code-view')?.textContent).toContain(
      'const a = 1',
    )
    expect(detailsRequest().value).toBeNull()
  })

  it('shows the Browser tab only for a pending preview', async () => {
    const root = mount()
    await flush()
    expect(tabButton(root, 'browser')).toBeNull()
    requestDetails({ tab: 'browser', previewId: 'preview_1' })
    await flush()
    expect(tabButton(root, 'browser')?.getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(root.querySelector('.browser-pane')).not.toBeNull()
  })

  it('shows the selected call input, output, meta and timing', async () => {
    const root = mount()
    await flush()
    selectCall('s1', 'call_42')
    await flush()
    await flush()
    expect(useFrameState().detailsTab).toBe('inspect')
    const pane = root.querySelector<HTMLElement>('.inspect-pane')!
    expect(pane.querySelector('.head-title')?.textContent).toBe('搜索')
    expect(pane.querySelector('.head-state')?.textContent).toContain('已完成')
    expect(pane.querySelector('[aria-label="输入"]')?.textContent).toContain(
      'TODO',
    )
    expect(pane.querySelector('[aria-label="输出"]')?.textContent).toContain(
      'matches',
    )
    expect(pane.querySelector('[aria-label="元数据"]')?.textContent).toContain(
      'total',
    )
    expect(pane.querySelector('[aria-label="计时"]')?.textContent).toContain(
      '耗时',
    )
    expect(pane.textContent).toContain('call_42')
  })

  it('routes "在轨迹中查看" to the trajectory with the call selected', async () => {
    const root = mount()
    await flush()
    selectCall('s1', 'call_42')
    await flush()
    await flush()
    const button = [...root.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('在轨迹中查看'),
    )
    button!.click()
    await vi.waitFor(() =>
      expect(router!.currentRoute.value.name).toBe('trajectory'),
    )
    expect(router!.currentRoute.value.params.sessionId).toBe('s1')
    expect(router!.currentRoute.value.query.call).toBe('call_42')
  })

  it('reports a call missing from the loaded window', async () => {
    const root = mount()
    await flush()
    selectCall('s1', 'call_missing')
    await flush()
    await flush()
    expect(root.textContent).toContain('找不到这个调用')
  })
})
