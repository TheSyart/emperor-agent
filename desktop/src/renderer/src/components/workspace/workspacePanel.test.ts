// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/backend')>()),
  onTerminalEvent: vi.fn(() => () => undefined),
  onSessionEvents: vi.fn(() => () => undefined),
}))

import WorkspacePanel from './WorkspacePanel.vue'
import {
  FRAME_STORAGE_KEY,
  frameActions,
  resetFrameStateForTest,
  useFrameState,
} from '../shell/frameState'
import {
  bindWorkspaceSnapshotSource,
  resetWorkspaceSnapshotForTest,
} from './useWorkspaceSnapshot'
import {
  consumeWorkspaceRequest,
  requestWorkspace,
  workspaceRequest,
} from './workspaceState'

const SNAPSHOT = {
  sessionId: 's1',
  capturedAt: 1,
  project: { name: 'demo', path: '/tmp/demo' },
  git: null,
  terminals: [],
  worktrees: { owned: [] },
  gitReceipts: [],
}

const GIT_STATUS = {
  repository: {
    branch: 'main',
    defaultBranch: 'main',
    detached: false,
    unborn: false,
    objectFormat: 'sha1',
    transientState: 'none',
  },
  branch: 'main',
  head: 'abc',
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [
    {
      path: 'README.md',
      index: '.',
      worktree: 'M',
      conflict: false,
      untracked: false,
    },
  ],
  truncated: false,
  revision: 'r1',
}
let withGit = false

function fakeCore(operation: string, payload?: Record<string, unknown>) {
  switch (operation) {
    case 'sidebar.get':
      return Promise.resolve({})
    case 'workspace.snapshot':
      return Promise.resolve(
        withGit ? { ...SNAPSHOT, git: GIT_STATUS } : SNAPSHOT,
      )
    case 'git.status':
      return Promise.resolve(GIT_STATUS)
    case 'git.branches':
      return Promise.resolve({ current: 'main', branches: [] })
    case 'git.worktrees':
      return Promise.resolve({ worktrees: [], owned: [] })
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
const sessionId = ref('s1')
const projectPath = ref('/tmp/demo')
const open = ref(true)

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    setup: () => () =>
      // Reactive `open` like AppFrame's slot prop.
      h(WorkspacePanel, { open: open.value, agentBusy: false }),
  })
  app.mount(container)
  return container
}

function row(root: HTMLElement, pane: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(
    `.launcher-row[data-pane="${pane}"]`,
  )!
}

function segment(root: HTMLElement, pane: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(
    `.segments button[data-pane="${pane}"]`,
  )!
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  window.localStorage.removeItem(FRAME_STORAGE_KEY)
  resetFrameStateForTest()
  resetWorkspaceSnapshotForTest()
  const pending = workspaceRequest().value
  if (pending) consumeWorkspaceRequest(pending)
  sessionId.value = 's1'
  projectPath.value = '/tmp/demo'
  open.value = true
  withGit = false
  delete (window as unknown as { emperor?: unknown }).emperor
  bindWorkspaceSnapshotSource({
    sessionId: () => sessionId.value,
    projectPath: () => projectPath.value,
  })
  core.mockImplementation(fakeCore)
  frameActions.openWorkspace(useFrameState())
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  resetWorkspaceSnapshotForTest()
  core.mockReset()
  vi.unstubAllGlobals()
})

describe('WorkspacePanel', () => {
  it('opens on the launcher with shortcut chips and the git reason', async () => {
    const root = mount()
    await flush()
    expect(root.querySelector('.workspace-title')?.textContent).toBe('工作台')
    const panes = [...root.querySelectorAll<HTMLElement>('.launcher-row')].map(
      (el) => el.dataset.pane,
    )
    expect(panes).toEqual(['review', 'terminal', 'files', 'browser'])
    for (const pane of panes)
      expect(row(root, pane!).querySelectorAll('.kbd').length).toBeGreaterThan(
        1,
      )
    expect(core).toHaveBeenCalledWith('workspace.snapshot', { sessionId: 's1' })
    // Snapshot without git: 审查 is disabled and says why.
    expect(row(root, 'review').disabled).toBe(true)
    expect(row(root, 'review').textContent).toContain('当前项目未初始化 Git')
    expect(row(root, 'terminal').disabled).toBe(false)
    expect(row(root, 'files').disabled).toBe(false)
    expect(row(root, 'browser').disabled).toBe(false)
  })

  it('disables project panes without a project, keeping the browser', async () => {
    projectPath.value = ''
    const root = mount()
    await flush()
    for (const pane of ['review', 'terminal', 'files']) {
      expect(row(root, pane).disabled).toBe(true)
      expect(row(root, pane).textContent).toContain('当前会话未绑定项目')
      expect(segment(root, pane).disabled).toBe(true)
    }
    expect(row(root, 'browser').disabled).toBe(false)
    expect(core).not.toHaveBeenCalledWith(
      'workspace.snapshot',
      expect.anything(),
    )
  })

  it('switches panes from the launcher and the header, home returns', async () => {
    const root = mount()
    await flush()
    row(root, 'terminal').click()
    await flush()
    expect(useFrameState().workspacePane).toBe('terminal')
    expect(root.querySelector('.workspace-title')?.textContent).toBe('终端')
    expect(segment(root, 'terminal').getAttribute('aria-pressed')).toBe('true')
    segment(root, 'files').click()
    await flush()
    expect(useFrameState().workspacePane).toBe('files')
    root
      .querySelector<HTMLButtonElement>('button[aria-label="工作台首页"]')!
      .click()
    await flush()
    expect(useFrameState().workspacePane).toBe('launcher')
    expect(root.querySelector('.workspace-launcher')).not.toBeNull()
  })

  it('closes the column through frameActions', async () => {
    const root = mount()
    await flush()
    root
      .querySelector<HTMLButtonElement>('button[aria-label="关闭工作台"]')!
      .click()
    expect(useFrameState().workspace).toBe(0)
  })

  it('requestWorkspace({ pane: files, file }) opens the file', async () => {
    const root = mount()
    await flush()
    requestWorkspace({ pane: 'files', file: { path: './src/a.ts', line: 1 } })
    await vi.waitFor(() =>
      expect(core).toHaveBeenCalledWith('files.read', {
        sessionId: 's1',
        relativePath: 'src/a.ts',
      }),
    )
    expect(useFrameState().workspacePane).toBe('files')
    await vi.waitFor(() =>
      expect(root.querySelector('.file-code-view')?.textContent).toContain(
        'const a = 1',
      ),
    )
    expect(workspaceRequest().value).toBeNull()
  })

  it('does not poll the snapshot while the column is closed', async () => {
    open.value = false
    mount()
    await flush()
    expect(core).not.toHaveBeenCalledWith(
      'workspace.snapshot',
      expect.anything(),
    )
    open.value = true
    await flush()
    expect(core).toHaveBeenCalledWith('workspace.snapshot', { sessionId: 's1' })
  })

  it('requestWorkspace({ pane: review, focus: commit }) focuses the commit box', async () => {
    withGit = true
    const root = mount()
    await flush()
    requestWorkspace({ pane: 'review', focus: 'commit' })
    const box = await vi.waitFor(() => {
      const found = root.querySelector<HTMLTextAreaElement>(
        '.git-commit-form textarea',
      )
      expect(found).not.toBeNull()
      return found!
    })
    await vi.waitFor(() => expect(document.activeElement).toBe(box))
    expect(useFrameState().workspacePane).toBe('review')
    // One-shot: going back to review later does not steal focus again.
    box.blur()
    segment(root, 'files').click()
    await flush()
    segment(root, 'review').click()
    await vi.waitFor(() =>
      expect(root.querySelector('.git-commit-form textarea')).not.toBeNull(),
    )
    await flush()
    expect(document.activeElement).not.toBe(
      root.querySelector('.git-commit-form textarea'),
    )
  })

  it('requestWorkspace({ pane: browser, url }) only prefills the address bar', async () => {
    const openBrowserUrl = vi.fn()
    const browserBounds = vi.fn()
    ;(window as unknown as { emperor: unknown }).emperor = {
      openBrowserUrl,
      browserBounds,
      browserClose: vi.fn(),
      onBrowserState: () => () => undefined,
    }
    // jsdom has no layout: give the browser slot a real rectangle.
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const size = this.classList.contains('browser-viewport')
          ? { width: 560, height: 700 }
          : { width: 0, height: 0 }
        return { x: 880, y: 100, ...size } as DOMRect
      })
    try {
      const root = mount()
      await flush()
      requestWorkspace({ pane: 'browser', url: 'http://localhost:5173' })
      await vi.waitFor(() =>
        expect(
          root.querySelector<HTMLInputElement>('.browser-address input')?.value,
        ).toBe('http://localhost:5173'),
      )
      expect(openBrowserUrl).not.toHaveBeenCalled()
      const rect = { x: 880, y: 100, width: 560, height: 700 }
      await vi.waitFor(() =>
        expect(browserBounds).toHaveBeenLastCalledWith(rect),
      )
      // Closing the column hides the native view.
      open.value = false
      await vi.waitFor(() =>
        expect(browserBounds).toHaveBeenLastCalledWith(null),
      )
    } finally {
      measure.mockRestore()
    }
  })
})
