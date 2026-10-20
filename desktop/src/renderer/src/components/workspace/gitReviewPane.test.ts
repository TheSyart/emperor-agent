// @vitest-environment jsdom
// FIX-05 (UI-7, UI-9, UI-26, UI-31): the 审查 pane keeps write errors apart
// from read errors, polls silently through the shared workspace snapshot
// only while it shows, never disables a text box, and forgets drafts when
// the session changes.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

import GitReviewPane from './GitReviewPane.vue'
import {
  bindWorkspaceSnapshotSource,
  resetWorkspaceSnapshotForTest,
  WORKSPACE_POLL_MS,
} from './useWorkspaceSnapshot'

const HEAD = 'a'.repeat(40)

function gitStatus(files: string[] = ['README.md'], head = HEAD) {
  return {
    repository: {
      branch: 'main',
      defaultBranch: 'main',
      detached: false,
      unborn: false,
      objectFormat: 'sha1',
      transientState: 'none',
    },
    branch: 'main',
    head,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: files.map((path) => ({
      path,
      index: '.',
      worktree: 'M',
      conflict: false,
      untracked: false,
    })),
    truncated: false,
    revision: 'b'.repeat(64),
  }
}

let status = gitStatus()
let commitError = ''
let statusError = ''
/** While set, refresh reads stay pending (a slow poll). */
let hold: Promise<never> | null = null

function fakeCore(operation: string, payload?: { sessionId?: string }) {
  const read = (value: unknown) => (hold ? hold : Promise.resolve(value))
  switch (operation) {
    case 'workspace.snapshot':
      return read({
        version: 1,
        sessionId: payload?.sessionId,
        capturedAt: Date.now(),
        project: { id: null, name: 'demo', path: '/tmp/demo' },
        git: status,
        worktrees: { worktrees: [], owned: [] },
        gitReceipts: [],
        terminals: [],
      })
    case 'git.status':
      return statusError ? Promise.reject(new Error(statusError)) : read(status)
    case 'git.branches':
      return read({
        current: 'main',
        branches: [{ name: 'main', head: HEAD, upstream: null }],
      })
    case 'git.worktrees':
      return read({ worktrees: [], owned: [] })
    case 'git.pullRequest':
      return read(null)
    case 'git.commit':
      return commitError
        ? Promise.reject(new Error(commitError))
        : Promise.resolve(gitStatus([]))
    default:
      return Promise.resolve(null)
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
const sessionId = ref('s1')
const agentBusy = ref(false)
const visible = ref(true)

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    setup: () => () =>
      h(GitReviewPane, {
        sessionId: sessionId.value,
        hasProject: true,
        agentBusy: agentBusy.value,
        visible: visible.value,
      }),
  })
  app.mount(container)
  return container
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function calls(operation: string): number {
  return core.mock.calls.filter(([op]) => op === operation).length
}

function gitCalls(): string[] {
  return core.mock.calls
    .map(([op]) => String(op))
    .filter((op) => op.startsWith('git.'))
}

function commitBox(root: HTMLElement): HTMLTextAreaElement {
  return root.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="提交信息"]',
  )!
}

function commitButton(root: HTMLElement): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(
    '.git-commit-form button[type="submit"]',
  )!
}

function field<T extends HTMLElement = HTMLInputElement>(
  root: HTMLElement,
  placeholder: string,
): T {
  return root.querySelector<T>(`[placeholder="${placeholder}"]`)!
}

function type(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  element.value = text
  element.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  resetWorkspaceSnapshotForTest()
  status = gitStatus()
  commitError = ''
  statusError = ''
  hold = null
  sessionId.value = 's1'
  agentBusy.value = false
  visible.value = true
  core.mockImplementation(fakeCore)
  bindWorkspaceSnapshotSource({
    sessionId: () => sessionId.value,
    projectPath: () => '/tmp/demo',
  })
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  resetWorkspaceSnapshotForTest()
  core.mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('GitReviewPane (FIX-05)', () => {
  it('1 · a commit the pre-commit hook rejects keeps its error on screen', async () => {
    commitError = 'pre-commit hook failed: eslint found 2 problems'
    const root = mount()
    await settle()
    type(commitBox(root), 'feat: add the thing')
    await settle()
    root
      .querySelector('form.git-commit-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(calls('git.commit')).toBe(1)
    const statusReads = calls('git.status')
    expect(root.textContent).toContain('pre-commit hook failed')
    // The refresh after the failure and the polls after it leave it there.
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 3)
    await settle()
    expect(calls('git.status') + calls('workspace.snapshot')).toBeGreaterThan(
      statusReads,
    )
    const alert = root.querySelector<HTMLElement>('[data-git-write-error]')
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toContain('pre-commit hook failed')
    // The message stays for another try.
    expect(commitBox(root).value).toBe('feat: add the thing')
    // Dismissing it is the user's call.
    alert!
      .querySelector<HTMLButtonElement>('button[aria-label="关闭错误提示"]')!
      .click()
    await settle()
    expect(root.textContent).not.toContain('pre-commit hook failed')
  })

  it('keeps a read error apart from the write error, and clears only the read one', async () => {
    commitError = 'pre-commit hook failed'
    const root = mount()
    await settle()
    type(commitBox(root), 'feat: x')
    root
      .querySelector('form.git-commit-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    statusError = 'git status timed out'
    root
      .querySelector<HTMLButtonElement>('button[aria-label="刷新 Git 状态"]')!
      .click()
    await settle()
    expect(root.querySelector('[data-git-read-error]')?.textContent).toContain(
      'git status timed out',
    )
    expect(root.querySelector('[data-git-write-error]')?.textContent).toContain(
      'pre-commit hook failed',
    )
    statusError = ''
    root
      .querySelector<HTMLButtonElement>('button[aria-label="刷新 Git 状态"]')!
      .click()
    await settle()
    expect(root.querySelector('[data-git-read-error]')).toBeNull()
    expect(root.querySelector('[data-git-write-error]')?.textContent).toContain(
      'pre-commit hook failed',
    )
  })

  it('2 · a poll keeps the commit box enabled and focused, and every key lands', async () => {
    const root = mount()
    await settle()
    const box = commitBox(root)
    box.focus()
    type(box, 'fix: a')
    // The next poll is slow: its replies stay pending while the user types.
    hold = new Promise<never>(() => undefined)
    const before =
      calls('workspace.snapshot') + calls('git.status') + calls('git.branches')
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS)
    await settle()
    expect(
      calls('workspace.snapshot') + calls('git.status') + calls('git.branches'),
    ).toBeGreaterThan(before)
    expect(box.disabled).toBe(false)
    expect(document.activeElement).toBe(box)
    type(box, `${box.value}bc`)
    await settle()
    expect(box.value).toBe('fix: abc')
    expect(commitBox(root)).toBe(box)
    // Silent: the refresh button shows no spinner and stays usable.
    const refresh = root.querySelector<HTMLButtonElement>(
      'button[aria-label="刷新 Git 状态"]',
    )!
    expect(refresh.disabled).toBe(false)
    expect(refresh.querySelector('.ds-spinner')).toBeNull()
  })

  it('3 · while the agent runs, every text box takes input; only the actions wait', async () => {
    agentBusy.value = true
    const root = mount()
    await settle()
    const boxes = [
      commitBox(root),
      field(root, '新分支名称'),
      field(root, '临时 worktree 分支名'),
      field(root, 'Pull Request 标题'),
      field<HTMLTextAreaElement>(root, 'Pull Request 正文'),
    ]
    for (const box of boxes) expect(box.disabled).toBe(false)
    type(commitBox(root), 'chore: while it runs')
    await settle()
    expect(commitBox(root).value).toBe('chore: while it runs')
    expect(commitButton(root).disabled).toBe(true)
    expect(root.textContent).toContain('Agent 正在写入项目')
    agentBusy.value = false
    await settle()
    expect(commitButton(root).disabled).toBe(false)
  })

  it('4 · a commit message written in one session is gone in the next', async () => {
    const root = mount()
    await settle()
    type(commitBox(root), 'feat: only for A')
    type(field(root, 'Pull Request 标题'), 'A title')
    type(field<HTMLTextAreaElement>(root, 'Pull Request 正文'), 'A body')
    type(field(root, '新分支名称'), 'a-branch')
    await settle()
    sessionId.value = 's2'
    await settle()
    expect(commitBox(root).value).toBe('')
    expect(field(root, 'Pull Request 标题').value).toBe('')
    expect(field<HTMLTextAreaElement>(root, 'Pull Request 正文').value).toBe('')
    expect(field(root, '新分支名称').value).toBe('')
    expect(commitButton(root).disabled).toBe(true)
  })

  it('10 · runs no git IPC while hidden, and asks for the PR at most once a minute', async () => {
    visible.value = false
    const root = mount()
    await settle()
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 6)
    await settle()
    expect(gitCalls()).toEqual([])
    expect(calls('workspace.snapshot')).toBe(0)

    visible.value = true
    await settle()
    expect(calls('git.status')).toBe(1)
    expect(calls('git.pullRequest')).toBe(1)
    // One polling source: the shared snapshot. Its status lands here.
    status = gitStatus(['README.md', 'src/new.ts'])
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 6)
    await settle()
    expect(calls('workspace.snapshot')).toBeGreaterThanOrEqual(6)
    expect(calls('git.status')).toBe(1)
    expect(root.textContent).toContain('src/new.ts')
    expect(calls('git.pullRequest')).toBe(1)
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 6)
    await settle()
    expect(calls('git.pullRequest')).toBe(2)

    // Hidden again: nothing more.
    visible.value = false
    await settle()
    const seen = gitCalls().length
    const snapshots = calls('workspace.snapshot')
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 12)
    await settle()
    expect(gitCalls()).toHaveLength(seen)
    expect(calls('workspace.snapshot')).toBe(snapshots)
  })
})
