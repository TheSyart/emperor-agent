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
import { resetBrowserPreferencesForTest } from '../../composables/useBrowserPreferences'
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
  openWorkspacePane,
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
    // No PTY in jsdom: the 终端 pane shows its error and no xterm.
    case 'terminals.list':
      return Promise.resolve([])
    case 'terminals.create':
      return Promise.reject(new Error('no PTY in this test'))
    case 'files.list':
      return Promise.resolve({
        projectRoot: '/tmp/demo',
        relativePath: String(payload?.relativePath ?? ''),
        entries: [],
      })
    case 'files.read':
    case 'files.preview':
      return Promise.resolve({
        id: 'file:/tmp/demo/src/a.ts',
        path: '/tmp/demo/src/a.ts',
        mimeType: 'text/plain',
        kind: 'text',
        name: 'a.ts',
        content: 'const a = 1\n',
        truncated: false,
        bytes: 12,
      })
    case 'workspace.turnDiff':
      return Promise.resolve({
        path: payload?.path,
        diff: [
          'diff --git a/src/a.ts b/src/a.ts',
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -1 +1,2 @@',
          ' const a = 1',
          '+const b = 2',
          '',
        ].join('\n'),
        truncated: false,
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

/** An entry of the no-history empty state. */
function entry(root: HTMLElement, pane: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(
    `.workspace-start .start-entry[data-pane="${pane}"]`,
  )!
}

/** A tab of the PaneHeader's segmented pane switch. */
function segment(root: HTMLElement, pane: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(
    `.workspace-panes [data-tab-id="${pane}"]`,
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
  resetBrowserPreferencesForTest()
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
  it('1 · with no history, shows the four pane entries with their shortcuts and reasons', async () => {
    const root = mount()
    await flush()
    expect(root.querySelector('.workspace-title')?.textContent).toBe('工作台')
    const panes = [
      ...root.querySelectorAll<HTMLElement>('.workspace-start .start-entry'),
    ].map((el) => el.dataset.pane)
    expect(panes).toEqual(['review', 'terminal', 'files', 'browser'])
    // An available pane shows its shortcut; an unavailable one says why.
    for (const pane of ['terminal', 'files', 'browser'])
      expect(
        entry(root, pane).querySelectorAll('.ds-kbd').length,
      ).toBeGreaterThan(1)
    expect(entry(root, 'review').querySelectorAll('.ds-kbd')).toHaveLength(0)
    expect(core).toHaveBeenCalledWith('workspace.snapshot', { sessionId: 's1' })
    // Snapshot without git: 审查 is disabled and says why.
    expect(entry(root, 'review').disabled).toBe(true)
    expect(entry(root, 'review').textContent).toContain('当前项目未初始化 Git')
    expect(entry(root, 'terminal').disabled).toBe(false)
    expect(entry(root, 'files').disabled).toBe(false)
    expect(entry(root, 'browser').disabled).toBe(false)
    // No tab is selected yet, and there is no home to go back to.
    expect(
      root.querySelector('.workspace-panes [aria-selected="true"]'),
    ).toBeNull()
    expect(root.querySelector('button[aria-label="工作台首页"]')).toBeNull()
  })

  it('disables project panes without a project, keeping the browser', async () => {
    projectPath.value = ''
    const root = mount()
    await flush()
    for (const pane of ['review', 'terminal']) {
      expect(entry(root, pane).disabled).toBe(true)
      expect(entry(root, pane).textContent).toContain('当前会话未绑定项目')
      expect(segment(root, pane).disabled).toBe(true)
      // The disabled tab says why on hover.
      expect(
        segment(root, pane).closest('.tab-item')?.getAttribute('title'),
      ).toBe('当前会话未绑定项目')
    }
    expect(entry(root, 'browser').disabled).toBe(false)
    expect(entry(root, 'files').disabled).toBe(false)
    expect(core).not.toHaveBeenCalledWith(
      'workspace.snapshot',
      expect.anything(),
    )
  })

  it('1 · opens straight on the pane used last, without a launcher', async () => {
    window.localStorage.setItem(
      FRAME_STORAGE_KEY,
      JSON.stringify({ workspace: 560, workspacePane: 'files' }),
    )
    resetFrameStateForTest()
    const root = mount()
    await flush()
    await vi.waitFor(() =>
      expect(root.querySelector('.files-pane')).not.toBeNull(),
    )
    expect(root.querySelector('.workspace-start')).toBeNull()
    expect(root.querySelector('.workspace-launcher')).toBeNull()
    expect(segment(root, 'files').getAttribute('aria-selected')).toBe('true')
    expect(root.querySelector('.workspace-title')?.textContent).toBe('文件')
  })

  it('1 · closing and reopening — or 打开工作台 from the card — keeps the last pane', async () => {
    const root = mount()
    await flush()
    entry(root, 'terminal').click()
    await flush()
    expect(useFrameState().workspacePane).toBe('terminal')
    root
      .querySelector<HTMLButtonElement>('button[aria-label="关闭工作台"]')!
      .click()
    await flush()
    // The environment card's 打开工作台 asks for no particular pane.
    openWorkspacePane('launcher')
    await flush()
    expect(useFrameState().workspace).toBeGreaterThan(0)
    expect(useFrameState().workspacePane).toBe('terminal')
    expect(root.querySelector('.workspace-start')).toBeNull()
    await vi.waitFor(() =>
      expect(root.querySelector('.terminal-pane')).not.toBeNull(),
    )
  })

  it('always offers the 浏览器 pane, whatever an old setting says', async () => {
    // 设置 › 浏览器 no longer turns the built-in browser off.
    ;(window as unknown as { emperor: unknown }).emperor = {
      invokeCore: vi.fn(async (operation: string) =>
        operation === 'browser.preferences'
          ? {
              enabled: false,
              linkTarget: 'system',
              localTarget: 'builtin',
              showFullUrl: true,
              history: true,
            }
          : null,
      ),
      onCoreEvent: () => () => undefined,
    }
    const root = mount()
    await flush()
    expect(entry(root, 'browser').disabled).toBe(false)
    expect(segment(root, 'browser').disabled).toBe(false)
    frameActions.openWorkspace(useFrameState(), 'browser')
    await flush()
    expect(useFrameState().workspacePane).toBe('browser')
    expect(root.querySelector('.workspace-empty')).toBeNull()
  })

  it('switches panes from the empty state and the header tabs', async () => {
    const root = mount()
    await flush()
    entry(root, 'terminal').click()
    await flush()
    expect(useFrameState().workspacePane).toBe('terminal')
    expect(root.querySelector('.workspace-title')?.textContent).toBe('终端')
    expect(segment(root, 'terminal').getAttribute('aria-selected')).toBe('true')
    segment(root, 'files').click()
    await flush()
    expect(useFrameState().workspacePane).toBe('files')
    segment(root, 'browser').click()
    await flush()
    expect(useFrameState().workspacePane).toBe('browser')
    expect(root.querySelector('.workspace-title')?.textContent).toBe('浏览器')
    expect(segment(root, 'desktop')).toBeNull()
    expect(root.querySelector('.workspace-start')).toBeNull()
  })

  it('heads the panel with a PaneHeader: the pane switch on the left, close on the right (UI-S06)', async () => {
    const root = mount()
    await flush()
    const header = root.querySelector<HTMLElement>(
      '.workspace-panel > .ds-pane-header',
    )!
    expect(header).not.toBeNull()
    const tabs = header.querySelector<HTMLElement>('.workspace-panes')!
    expect(tabs.dataset.variant).toBe('segmented')
    expect(tabs.getAttribute('aria-label')).toBe('工作台面板')
    expect(
      [...tabs.querySelectorAll('[role="tab"]')].map((tab) =>
        tab.textContent?.trim(),
      ),
    ).toEqual(['审查', '终端', '文件', '浏览器'])
    const buttons = [...header.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.at(-1)?.getAttribute('aria-label')).toBe('关闭工作台')
    expect(header.querySelector('button[aria-label="工作台首页"]')).toBeNull()
    // The system title bar moves the window again (UI-S11): no drag region.
    expect(header.hasAttribute('data-app-drag')).toBe(false)
    // 48px PaneHeader pulled up 2px: its bottom meets the 46px bar.
    const source = (await import('./WorkspacePanel.vue?raw')).default
    expect(source).toMatch(
      /\.workspace-header\s*\{[^}]*margin-top:\s*calc\(var\(--shell-bar-h\) - var\(--pane-header-h\)\)/,
    )
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
      expect(core).toHaveBeenCalledWith('files.preview', {
        source: 'project',
        sessionId: 's1',
        path: 'src/a.ts',
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

  it('opens a file the child log on screen asks for (its owner is the child)', async () => {
    bindWorkspaceSnapshotSource({
      sessionId: () => sessionId.value,
      projectPath: () => projectPath.value,
      viewedSessionId: () => 'child-1',
    })
    const root = mount()
    await flush()
    requestWorkspace({
      pane: 'files',
      file: {
        owner: 'child-1',
        target: { source: 'attachment', attachmentId: 'att_2026-10_12345678' },
      },
    })
    await vi.waitFor(() =>
      expect(core).toHaveBeenCalledWith('files.preview', {
        source: 'attachment',
        attachmentId: 'att_2026-10_12345678',
      }),
    )
    await vi.waitFor(() =>
      expect(
        root.querySelector('.files-pane .tab-item[data-active]'),
      ).not.toBeNull(),
    )
  })

  it('requestWorkspace({ pane: files, directory }) opens the folder in the tree', async () => {
    const root = mount()
    await flush()
    requestWorkspace({ pane: 'files', directory: 'src' })
    await vi.waitFor(() =>
      expect(core).toHaveBeenCalledWith('files.list', {
        sessionId: 's1',
        relativePath: 'src',
        limit: 500,
      }),
    )
    expect(useFrameState().workspacePane).toBe('files')
    expect(core).not.toHaveBeenCalledWith('files.read', expect.anything())
    expect(workspaceRequest().value).toBeNull()
    void root
  })

  it('requestWorkspace({ pane: review, turn }) shows that turn, and 返回 the Git review', async () => {
    withGit = true
    const root = mount()
    await flush()
    requestWorkspace({
      pane: 'review',
      turn: {
        sessionId: 's1',
        turn: 4,
        files: [
          { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 },
          {
            path: 'logo.png',
            status: 'added',
            additions: null,
            deletions: null,
            binary: true,
          },
        ],
      },
    })
    await vi.waitFor(() =>
      expect(root.querySelector('[data-turn-review="4"]')).not.toBeNull(),
    )
    await vi.waitFor(() =>
      expect(core).toHaveBeenCalledWith('workspace.turnDiff', {
        sessionId: 's1',
        turn: 4,
        path: 'src/a.ts',
      }),
    )
    await vi.waitFor(() =>
      expect(
        root.querySelector('.turn-review [data-diff]')?.textContent,
      ).toContain('const b = 2'),
    )
    // A binary file has no diff to fetch.
    root.querySelectorAll<HTMLButtonElement>('.turn-review .file')[1]!.click()
    await flush()
    expect(root.querySelector('.turn-review .diff')?.textContent).toContain(
      '二进制，没有可显示的差异。',
    )
    root
      .querySelector<HTMLButtonElement>('.turn-review [aria-label="返回审查"]')!
      .click()
    await flush()
    expect(root.querySelector('[data-turn-review]')).toBeNull()
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

  it('5 · the browser page survives switching to 终端 and back (FIX-05)', async () => {
    let emit: (state: unknown) => void = () => undefined
    const browserBounds = vi.fn()
    const browserClose = vi.fn()
    ;(window as unknown as { emperor: unknown }).emperor = {
      openBrowserUrl: vi.fn(),
      browserBounds,
      browserClose,
      onBrowserState: (listener: (state: unknown) => void) => {
        emit = listener
        return () => undefined
      },
    }
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const shown =
          this.classList.contains('browser-viewport') &&
          this.closest<HTMLElement>('.browser-pane')?.style.display !== 'none'
        return {
          x: 880,
          y: 100,
          ...(shown ? { width: 560, height: 700 } : { width: 0, height: 0 }),
        } as DOMRect
      })
    try {
      const root = mount()
      await flush()
      segment(root, 'browser').click()
      await vi.waitFor(() =>
        expect(root.querySelector('.browser-pane')).not.toBeNull(),
      )
      emit({
        url: 'https://example.com/account',
        title: 'Account',
        loading: false,
        canGoBack: true,
        canGoForward: false,
      })
      await flush()
      const address = () =>
        root.querySelector<HTMLInputElement>('.browser-address input')!.value
      expect(address()).toContain('example.com')
      const rect = { x: 880, y: 100, width: 560, height: 700 }
      await vi.waitFor(() =>
        expect(browserBounds).toHaveBeenLastCalledWith(rect),
      )

      segment(root, 'terminal').click()
      await flush()
      // Hidden, not closed: the native view only stops drawing.
      await vi.waitFor(() =>
        expect(browserBounds).toHaveBeenLastCalledWith(null),
      )
      expect(browserClose).not.toHaveBeenCalled()
      const pane = root.querySelector<HTMLElement>('.browser-pane')!
      expect(pane.style.display).toBe('none')

      segment(root, 'browser').click()
      await flush()
      expect(root.querySelector('.browser-pane')).toBe(pane)
      expect(pane.style.display).toBe('')
      expect(address()).toContain('example.com')
      await vi.waitFor(() =>
        expect(browserBounds).toHaveBeenLastCalledWith(rect),
      )
      expect(browserClose).not.toHaveBeenCalled()

      // Collapsing the column hides it too; the page stays.
      open.value = false
      await vi.waitFor(() =>
        expect(browserBounds).toHaveBeenLastCalledWith(null),
      )
      open.value = true
      await flush()
      expect(browserClose).not.toHaveBeenCalled()

      // A session switch ends it.
      sessionId.value = 's2'
      await flush()
      expect(browserClose).toHaveBeenCalledTimes(1)
    } finally {
      measure.mockRestore()
    }
  })

  it('a session switch on another pane closes the browser page it left behind', async () => {
    const browserClose = vi.fn()
    ;(window as unknown as { emperor: unknown }).emperor = {
      browserBounds: vi.fn(),
      browserClose,
      onBrowserState: () => () => undefined,
    }
    const root = mount()
    await flush()
    segment(root, 'browser').click()
    await vi.waitFor(() =>
      expect(root.querySelector('.browser-pane')).not.toBeNull(),
    )
    segment(root, 'files').click()
    await flush()
    expect(browserClose).not.toHaveBeenCalled()
    sessionId.value = 's2'
    await flush()
    expect(browserClose).toHaveBeenCalledTimes(1)
    expect(root.querySelector('.browser-pane')).toBeNull()
  })

  it('keeps the 文件 tabs across pane switches (FIX-05)', async () => {
    const root = mount()
    await flush()
    requestWorkspace({ pane: 'files', file: { path: 'src/a.ts' } })
    await vi.waitFor(() =>
      expect(
        root.querySelector('.files-pane .tab-item[data-active]')?.textContent,
      ).toContain('a.ts'),
    )
    const listings = core.mock.calls.filter(
      ([op]) => op === 'files.list',
    ).length
    segment(root, 'browser').click()
    await flush()
    segment(root, 'files').click()
    await flush()
    expect(
      root.querySelector('.files-pane .tab-item[data-active]')?.textContent,
    ).toContain('a.ts')
    expect(core.mock.calls.filter(([op]) => op === 'files.list')).toHaveLength(
      listings,
    )
  })

  it('8 · a file changed on disk shows its new content at the linked line (FIX-05)', async () => {
    const disk = { content: 'const a = 1\n', bytes: 12, modifiedAt: 1 }
    core.mockImplementation(
      (operation: string, payload?: Record<string, unknown>) => {
        if (operation === 'files.stat')
          return Promise.resolve({
            bytes: disk.bytes,
            modifiedAt: disk.modifiedAt,
          })
        if (operation === 'files.preview')
          return Promise.resolve({
            id: 'file:/tmp/demo/src/a.ts',
            path: '/tmp/demo/src/a.ts',
            mimeType: 'text/plain',
            kind: 'text',
            name: 'a.ts',
            content: disk.content,
            truncated: false,
            bytes: disk.bytes,
            modifiedAt: disk.modifiedAt,
          })
        return fakeCore(operation, payload)
      },
    )
    const root = mount()
    await flush()
    requestWorkspace({ pane: 'files', file: { path: 'src/a.ts', line: 1 } })
    await vi.waitFor(() =>
      expect(root.querySelector('.file-code-view')?.textContent).toContain(
        'const a = 1',
      ),
    )
    disk.content = 'const a = 1\nconst b = 2\nconst c = 3\n'
    disk.bytes = 36
    disk.modifiedAt = 2
    requestWorkspace({ pane: 'files', file: { path: 'src/a.ts', line: 3 } })
    await vi.waitFor(() =>
      expect(
        root.querySelector('.file-code-line.reference-line-active')
          ?.textContent,
      ).toContain('const c = 3'),
    )
  })

  it('10 · no git polling IPC while the column is closed (FIX-05)', async () => {
    withGit = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    frameActions.openWorkspace(useFrameState(), 'review')
    // Load the pane chunks first: the fake clock below must not hold them.
    await import('./GitReviewPane.vue')
    await import('./FilesPane.vue')
    vi.useFakeTimers()
    try {
      const gitCalls = () =>
        core.mock.calls.filter(([op]) => String(op).startsWith('git.')).length
      open.value = false
      const root = mount()
      await flush()
      await vi.advanceTimersByTimeAsync(30_000)
      await flush()
      expect(gitCalls()).toBe(0)
      // Open on 审查: it loads and refreshes with the shared poll.
      open.value = true
      await vi.waitFor(() => expect(gitCalls()).toBeGreaterThan(0))
      await vi.advanceTimersByTimeAsync(10_000)
      // Closed again: quiet.
      open.value = false
      await flush()
      let seen = gitCalls()
      await vi.advanceTimersByTimeAsync(30_000)
      await flush()
      expect(gitCalls()).toBe(seen)
      // Open on another pane: 审查 is not on screen, so still no git polls.
      open.value = true
      segment(root, 'files').click()
      await flush()
      seen = gitCalls()
      await vi.advanceTimersByTimeAsync(30_000)
      await flush()
      expect(gitCalls()).toBe(seen)
    } finally {
      vi.useRealTimers()
    }
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
