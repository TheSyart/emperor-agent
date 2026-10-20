// @vitest-environment jsdom
// FIX-05 (UI-7, UI-9, UI-26, UI-31): the 审查 pane keeps write errors apart
// from read errors, polls silently through the shared workspace snapshot
// only while it shows, never disables a text box, and forgets drafts when
// the session changes.
// UI-S06: two change groups (empty ones not drawn), every Git action in the
// 「分支名 ▾」 menu, a one-line Pull Request area, ≤ 600 lines.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { core, openLink } = vi.hoisted(() => ({
  core: vi.fn(),
  openLink: vi.fn(),
}))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/backend')>()),
  openLink,
}))

import GitReviewPane from './GitReviewPane.vue'
import { answerConfirmsForTest } from '../ui/confirm'
import {
  bindWorkspaceSnapshotSource,
  resetWorkspaceSnapshotForTest,
  WORKSPACE_POLL_MS,
} from './useWorkspaceSnapshot'

const HEAD = 'a'.repeat(40)
const REVISION = 'b'.repeat(64)

interface FileSpec {
  path: string
  index?: string
  worktree?: string
  untracked?: boolean
}

function gitStatus(
  files: Array<string | FileSpec> = ['README.md'],
  head = HEAD,
  extra: Record<string, unknown> = {},
) {
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
    files: files.map((spec) => {
      const entry = typeof spec === 'string' ? { path: spec } : spec
      return {
        path: entry.path,
        index: entry.index ?? '.',
        worktree: entry.worktree ?? 'M',
        conflict: false,
        untracked: entry.untracked ?? false,
        additions: 3,
        deletions: 1,
      }
    }),
    truncated: false,
    revision: REVISION,
    ...extra,
  }
}

const PR = {
  number: 42,
  url: 'https://github.com/acme/demo/pull/42',
  state: 'OPEN',
  draft: true,
  mergeable: 'MERGEABLE',
  headRefName: 'feature/x',
  baseRefName: 'main',
  checks: [],
}

let status = gitStatus()
let commitError = ''
let statusError = ''
let pullRequest: unknown = null
let pullRequestError = ''
let owned: unknown[] = []
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
        worktrees: { worktrees: [], owned },
        gitReceipts: [],
        terminals: [],
      })
    case 'git.status':
      return statusError ? Promise.reject(new Error(statusError)) : read(status)
    case 'git.branches':
      return read({
        current: status.branch,
        branches: [
          { name: 'main', head: HEAD, upstream: 'origin/main' },
          { name: 'feature/x', head: HEAD, upstream: null },
        ],
      })
    case 'git.worktrees':
      return read({ worktrees: [], owned })
    case 'git.remote':
      return read({
        name: 'origin',
        webUrl: 'https://github.com/acme/demo',
        provider: 'github',
      })
    case 'git.pullRequest':
      return pullRequestError
        ? Promise.reject(new Error(pullRequestError))
        : read(pullRequest)
    case 'git.diff':
      return Promise.resolve({
        content: [
          'diff --git a/README.md b/README.md',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1 +1,2 @@',
          ' # Demo',
          '+Added line',
          '',
        ].join('\n'),
        truncated: false,
      })
    case 'git.commit':
      return commitError
        ? Promise.reject(new Error(commitError))
        : Promise.resolve(gitStatus([]))
    case 'git.enterWorktree':
    case 'git.exitWorktree':
      return Promise.resolve({ status })
    case 'git.stage':
    case 'git.unstage':
    case 'git.discard':
    case 'git.fetch':
    case 'git.pull':
    case 'git.push':
    case 'git.createBranch':
    case 'git.switchBranch':
      return Promise.resolve(status)
    default:
      return Promise.resolve(null)
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
let router: Router
const sessionId = ref('s1')
const agentBusy = ref(false)
const visible = ref(true)

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      {
        path: '/pulls/:owner?/:repo?/:number?',
        name: 'pulls',
        component: { render: () => null },
      },
    ],
  })
  app = createApp({
    setup: () => () =>
      h(GitReviewPane, {
        sessionId: sessionId.value,
        hasProject: true,
        agentBusy: agentBusy.value,
        visible: visible.value,
      }),
  })
  app.use(router)
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

function lastCall(operation: string): Record<string, unknown> | undefined {
  return core.mock.calls.filter(([op]) => op === operation).at(-1)?.[1]
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

function type(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  element.value = text
  element.dispatchEvent(new Event('input'))
}

function menu(label: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(
    `[role="menu"][aria-label="${label}"]`,
  )
}

function menuItem(action: string): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>(
    `[role="menu"] [data-action="${action}"]`,
  )!
}

async function openBranchMenu(root: HTMLElement): Promise<HTMLElement> {
  root.querySelector<HTMLButtonElement>('button[data-branch-menu]')!.click()
  await settle()
  return menu('Git 操作')!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  resetWorkspaceSnapshotForTest()
  status = gitStatus()
  commitError = ''
  statusError = ''
  pullRequest = null
  pullRequestError = ''
  owned = []
  hold = null
  sessionId.value = 's1'
  agentBusy.value = false
  visible.value = true
  core.mockImplementation(fakeCore)
  openLink.mockReset()
  openLink.mockResolvedValue('system')
  answerConfirmsForTest(() => true)
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
  document.body.innerHTML = ''
  answerConfirmsForTest(null)
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
    expect(commitBox(root).disabled).toBe(false)
    type(commitBox(root), 'chore: while it runs')
    await settle()
    expect(commitBox(root).value).toBe('chore: while it runs')
    expect(commitButton(root).disabled).toBe(true)
    expect(root.textContent).toContain('智能体运行中')
    // The new-branch box opens and takes a name; only 创建 waits.
    await openBranchMenu(root)
    menuItem('create-branch').click()
    await settle()
    const name = document.body.querySelector<HTMLInputElement>(
      '[placeholder="新分支名称"]',
    )!
    expect(name.disabled).toBe(false)
    type(name, 'topic')
    await settle()
    const create = [
      ...document.body.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"][aria-label="新建分支"] button',
      ),
    ].find((button) => button.textContent?.trim() === '创建')!
    expect(create.disabled).toBe(true)
    agentBusy.value = false
    await settle()
    expect(commitButton(root).disabled).toBe(false)
    expect(create.disabled).toBe(false)
  })

  it('4 · a commit message written in one session is gone in the next', async () => {
    const root = mount()
    await settle()
    type(commitBox(root), 'feat: only for A')
    await openBranchMenu(root)
    menuItem('create-branch').click()
    await settle()
    type(
      document.body.querySelector<HTMLInputElement>(
        '[placeholder="新分支名称"]',
      )!,
      'a-branch',
    )
    await settle()
    sessionId.value = 's2'
    await settle()
    expect(commitBox(root).value).toBe('')
    expect(commitButton(root).disabled).toBe(true)
    await openBranchMenu(root)
    menuItem('create-branch').click()
    await settle()
    expect(
      document.body.querySelector<HTMLInputElement>(
        '[placeholder="新分支名称"]',
      )!.value,
    ).toBe('')
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
    expect(root.textContent).toContain('new.ts')
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

describe('GitReviewPane (UI-S06)', () => {
  it('2 · draws 已暂存 and 未暂存 only when they have files', async () => {
    const root = mount()
    await settle()
    const groups = () =>
      [...root.querySelectorAll<HTMLElement>('.change-group')].map(
        (group) => group.dataset.group,
      )
    expect(groups()).toEqual(['unstaged'])
    expect(root.querySelector('.change-group .group-label')?.textContent).toBe(
      '未暂存',
    )
    expect(root.querySelector('[data-group="staged"]')).toBeNull()

    status = gitStatus([
      { path: 'src/a.ts', index: 'M', worktree: '.' },
      'README.md',
      { path: 'notes.md', index: '?', worktree: '?', untracked: true },
    ])
    root
      .querySelector<HTMLButtonElement>('button[aria-label="刷新 Git 状态"]')!
      .click()
    await settle()
    expect(groups()).toEqual(['staged', 'unstaged'])
    const unstaged = root.querySelector<HTMLElement>('[data-group="unstaged"]')!
    expect(unstaged.querySelector('.group-count')?.textContent?.trim()).toBe(
      '2',
    )
    expect(
      [...unstaged.querySelectorAll<HTMLElement>('.change-row')].map(
        (row) => row.dataset.path,
      ),
    ).toEqual(['README.md', 'notes.md'])

    status = gitStatus([])
    root
      .querySelector<HTMLButtonElement>('button[aria-label="刷新 Git 状态"]')!
      .click()
    await settle()
    expect(groups()).toEqual([])
    expect(root.textContent).toContain('没有未提交的改动')
  })

  it('stages, unstages and discards from the row, and shows a diff on click', async () => {
    status = gitStatus([
      { path: 'src/a.ts', index: 'M', worktree: '.' },
      'README.md',
    ])
    const root = mount()
    await settle()
    const unstagedRow = root.querySelector<HTMLElement>(
      '[data-group="unstaged"] .change-row[data-path="README.md"]',
    )!
    // Row actions: 暂存 and 丢弃 for a working-tree change …
    expect(
      unstagedRow.querySelector('button[aria-label="暂存 README.md"]'),
    ).not.toBeNull()
    unstagedRow
      .querySelector<HTMLButtonElement>('button[aria-label="丢弃 README.md"]')!
      .click()
    await settle()
    expect(lastCall('git.discard')).toEqual({
      sessionId: 's1',
      paths: ['README.md'],
      expectedRevision: REVISION,
      confirmed: true,
    })
    unstagedRow
      .querySelector<HTMLButtonElement>('button[aria-label="暂存 README.md"]')!
      .click()
    await settle()
    expect(lastCall('git.stage')).toEqual({
      sessionId: 's1',
      paths: ['README.md'],
      expectedRevision: REVISION,
    })
    // … 取消暂存 for a staged one.
    root
      .querySelector<HTMLButtonElement>(
        '[data-group="staged"] button[aria-label="取消暂存 src/a.ts"]',
      )!
      .click()
    await settle()
    expect(lastCall('git.unstage')).toMatchObject({ paths: ['src/a.ts'] })
    // Clicking the file shows its diff under the row; again hides it.
    root
      .querySelector<HTMLButtonElement>(
        '[data-group="unstaged"] .change-row[data-path="README.md"] .change-main',
      )!
      .click()
    await settle()
    expect(lastCall('git.diff')).toEqual({
      sessionId: 's1',
      path: 'README.md',
      area: 'worktree',
    })
    expect(
      root.querySelector('.change-diff [data-diff]')?.textContent,
    ).toContain('Added line')
    root
      .querySelector<HTMLButtonElement>(
        '[data-group="unstaged"] .change-row[data-path="README.md"] .change-main',
      )!
      .click()
    await settle()
    expect(root.querySelector('.change-diff')).toBeNull()
  })

  it('3 · the 分支名 ▾ menu holds every Git action, and each one runs', async () => {
    status = gitStatus(['README.md'], HEAD, {
      branch: 'feature/x',
      upstream: null,
    })
    const root = mount()
    await settle()
    const trigger = root.querySelector<HTMLButtonElement>(
      'button[data-branch-menu]',
    )!
    expect(trigger.textContent).toContain('feature/x')
    const opened = await openBranchMenu(root)
    const actions = [
      ...opened.querySelectorAll<HTMLElement>('[data-action]'),
    ].map((item) => item.dataset.action)
    expect(actions).toEqual([
      'switch-branch',
      'create-branch',
      'fetch',
      'pull',
      'push',
      'compare',
      'enter-worktree',
    ])
    expect(opened.textContent).toContain('切换分支')
    expect(opened.textContent).toContain('新建分支')
    expect(opened.textContent).toContain('比较分支')

    menuItem('fetch').click()
    await settle()
    expect(lastCall('git.fetch')).toEqual({ sessionId: 's1', confirmed: true })

    await openBranchMenu(root)
    menuItem('pull').click()
    await settle()
    expect(lastCall('git.pull')).toEqual({
      sessionId: 's1',
      expectedRevision: REVISION,
      confirmed: true,
    })

    await openBranchMenu(root)
    menuItem('push').click()
    await settle()
    expect(lastCall('git.push')).toEqual({
      sessionId: 's1',
      expectedRevision: REVISION,
      setUpstream: true,
      confirmed: true,
    })

    await openBranchMenu(root)
    menuItem('compare').click()
    await settle()
    expect(openLink).toHaveBeenCalledWith(
      'https://github.com/acme/demo/compare/main...feature/x',
    )

    await openBranchMenu(root)
    menuItem('switch-branch').click()
    await settle()
    const branches = menu('切换分支')!
    const main = [
      ...branches.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('main'))!
    main.click()
    await settle()
    expect(lastCall('git.switchBranch')).toEqual({
      sessionId: 's1',
      name: 'main',
      expectedRevision: REVISION,
      confirmed: true,
    })

    await openBranchMenu(root)
    menuItem('create-branch').click()
    await settle()
    const name = document.body.querySelector<HTMLInputElement>(
      '[placeholder="新分支名称"]',
    )!
    type(name, 'topic')
    await settle()
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    expect(lastCall('git.createBranch')).toEqual({
      sessionId: 's1',
      name: 'topic',
      expectedRevision: REVISION,
    })

    await openBranchMenu(root)
    menuItem('enter-worktree').click()
    await settle()
    expect(lastCall('git.enterWorktree')).toEqual({
      sessionId: 's1',
      expectedRevision: REVISION,
      confirmed: true,
    })
  })

  it('3 · inside a worktree the menu leaves it or removes it safely', async () => {
    owned = [
      {
        id: 'wt1',
        path: '/tmp/state/wt1',
        branch: 'emperor-wt1',
        head: HEAD,
        active: true,
      },
    ]
    const root = mount()
    await settle()
    expect(root.querySelector('[data-worktree-badge]')).not.toBeNull()
    await openBranchMenu(root)
    expect(menuItem('enter-worktree')).toBeNull()
    menuItem('exit-worktree').click()
    await settle()
    expect(lastCall('git.exitWorktree')).toEqual({
      sessionId: 's1',
      action: 'keep',
      discardChanges: false,
      expectedRevision: REVISION,
      confirmed: true,
    })
    await openBranchMenu(root)
    menuItem('remove-worktree').click()
    await settle()
    expect(lastCall('git.exitWorktree')).toMatchObject({ action: 'remove' })
  })

  it('3 · a refused confirm runs nothing, and writes wait while the agent runs', async () => {
    answerConfirmsForTest(() => false)
    const root = mount()
    await settle()
    await openBranchMenu(root)
    menuItem('push').click()
    await settle()
    expect(calls('git.push')).toBe(0)

    agentBusy.value = true
    await settle()
    const opened = await openBranchMenu(root)
    for (const action of ['switch-branch', 'pull', 'push', 'enter-worktree'])
      expect(menuItem(action).disabled).toBe(true)
    // Reading the remote and opening the compare page are no writes.
    expect(menuItem('fetch').disabled).toBe(false)
    expect(menuItem('create-branch').disabled).toBe(false)
    expect(opened.textContent).toContain('智能体运行中')
  })

  it('4 · the commit box takes input while the agent runs; only 提交 waits', async () => {
    agentBusy.value = true
    const root = mount()
    await settle()
    const box = commitBox(root)
    expect(box.disabled).toBe(false)
    type(box, 'docs: draft while it runs')
    await settle()
    expect(box.value).toBe('docs: draft while it runs')
    expect(commitButton(root).disabled).toBe(true)
    const commitPush = root.querySelector<HTMLButtonElement>(
      '.git-commit-form button[data-action="commit-push"]',
    )!
    expect(commitPush.disabled).toBe(true)
    agentBusy.value = false
    await settle()
    expect(commitButton(root).disabled).toBe(false)
    expect(commitPush.disabled).toBe(false)
  })

  it('提交并推送 commits and then pushes the new revision', async () => {
    const root = mount()
    await settle()
    type(commitBox(root), 'feat: ship it')
    await settle()
    root
      .querySelector<HTMLButtonElement>(
        '.git-commit-form button[data-action="commit-push"]',
      )!
      .click()
    await settle()
    expect(lastCall('git.commit')).toEqual({
      sessionId: 's1',
      message: 'feat: ship it',
      expectedRevision: REVISION,
    })
    expect(lastCall('git.push')).toMatchObject({
      sessionId: 's1',
      setUpstream: true,
      confirmed: true,
    })
    const order = core.mock.calls
      .map(([op]) => op)
      .filter((op) => op === 'git.commit' || op === 'git.push')
    expect(order).toEqual(['git.commit', 'git.push'])
    expect(commitBox(root).value).toBe('')
  })

  it('5 · the Pull Request area is one line that links to the Pull Request page', async () => {
    pullRequest = PR
    const root = mount()
    await settle()
    const lines = root.querySelectorAll<HTMLElement>('[data-pr-line]')
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect(line.dataset.state).toBe('open')
    expect(line.textContent).toContain('#42')
    expect(line.textContent).toContain('草稿')
    // No PR editor or PR writes left in the pane.
    for (const gone of [
      'Squash merge',
      'Close',
      'Mark ready',
      '发布 PR',
      '更新 PR',
      '生成发布预览',
    ])
      expect(root.textContent).not.toContain(gone)
    expect(root.querySelector('[placeholder="Pull Request 标题"]')).toBeNull()
    const link = [...line.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '在 Pull Request 页查看',
    )!
    link.click()
    await settle()
    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/pulls/acme/demo/42'),
    )
    // Merging and closing happen on the PR's web page.
    line
      .querySelector<HTMLButtonElement>('button[aria-label="在 GitHub 打开"]')!
      .click()
    await settle()
    expect(openLink).toHaveBeenCalledWith(PR.url)
  })

  it('5 · without a PR the line still links to the page; without gh it is one hint', async () => {
    const root = mount()
    await settle()
    let line = root.querySelector<HTMLElement>('[data-pr-line]')!
    expect(line.dataset.state).toBe('none')
    expect(line.textContent).toContain('在 Pull Request 页查看')

    app?.unmount()
    container?.remove()
    pullRequestError = 'git_gh_unavailable: GitHub CLI unavailable'
    resetWorkspaceSnapshotForTest()
    bindWorkspaceSnapshotSource({
      sessionId: () => sessionId.value,
      projectPath: () => '/tmp/demo',
    })
    const next = mount()
    await settle()
    const hints = next.querySelectorAll<HTMLElement>('[data-pr-line]')
    expect(hints).toHaveLength(1)
    line = hints[0]!
    expect(line.dataset.state).toBe('unavailable')
    expect(line.textContent).toContain('GitHub CLI 不可用')
    expect(line.querySelector('button')).toBeNull()
  })

  it('has Chinese titles, no objectFormat label and no English section names', async () => {
    const root = mount()
    await settle()
    const text = root.textContent ?? ''
    for (const english of [
      'SHA1',
      'Branches',
      'Worktrees',
      'Staged',
      'Changes',
      'Untracked',
      'Conflicts',
      'Compare',
      'Commit',
      'Pull Request #',
    ])
      expect(text).not.toContain(english)
  })

  it('7 · the review pane stays within 600 lines', async () => {
    const source = (await import('./GitReviewPane.vue?raw')).default
    expect(source.trimEnd().split('\n').length).toBeLessThanOrEqual(600)
  })
})
