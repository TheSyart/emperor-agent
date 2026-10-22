// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App, type Component } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import PullRequestsPage from '../pulls/PullRequestsPage.vue'
import GitHubIssuesPage from './GitHubIssuesPage.vue'
import GitHubRunsPage from './GitHubRunsPage.vue'

type Dict = Record<string, any>

const MARKUP = '<img src=x onerror=alert(1)> crash on start'

const ISSUES = [
  {
    repo: 'acme/widgets',
    number: 12,
    title: MARKUP,
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/12',
    author: 'octo-dev',
    createdAt: '2026-09-20T08:00:00Z',
    updatedAt: '2026-09-29T08:00:00Z',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    commentCount: 41,
  },
  {
    repo: 'acme/tools',
    number: 3,
    title: 'Docs',
    state: 'OPEN',
    url: 'https://github.com/acme/tools/issues/3',
    author: 'helper',
    createdAt: '2026-09-20T08:00:00Z',
    updatedAt: '2026-09-28T08:00:00Z',
    labels: [{ name: 'docs', color: 'red;background:url(x)' }],
    commentCount: 0,
  },
]

const RUN = {
  id: 36566264518,
  name: 'ci',
  title: 'test: give the process tree time',
  status: 'completed',
  conclusion: 'failure',
  event: 'push',
  branch: 'main',
  runNumber: 77,
  createdAt: '2026-09-29T12:09:27Z',
  updatedAt: '2026-09-29T12:20:00Z',
  url: 'https://github.com/acme/widgets/actions/runs/36566264518',
  actor: 'octo-dev',
}

let app: App | null = null
let container: HTMLDivElement | null = null
let calls: Array<[string, Dict | undefined]> = []
let ghStatus: Dict = { available: true, login: 'octo-dev', version: '2.73.0' }

function github(patch: Dict = {}): Dict {
  return {
    pluginId: 'github',
    scope: 'managed',
    enabled: true,
    effective: true,
    activation: 'active',
    ...patch,
  }
}

const context = {
  boot: ref<Dict>({ plugins: [github()] }),
  sessionId: ref('session-1'),
  showToast: vi.fn(),
  runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
}

function installBridge() {
  calls = []
  ;(window as unknown as { emperor: unknown }).emperor = {
    invokeCore: async (key: string, input?: Dict) => {
      calls.push([key, input])
      switch (key) {
        case 'pullRequests.status':
          return ghStatus
        case 'pullRequests.list':
          return { items: [], total: 0 }
        case 'github.listIssues':
          return { items: ISSUES, total: 57 }
        case 'github.viewIssue':
          return {
            ...ISSUES[0],
            body: 'Steps:\n1. open',
            stateReason: null,
            closedAt: null,
            assignees: ['octo-dev'],
            comments: [
              {
                author: 'helper',
                body: 'Same here',
                createdAt: '2026-09-29T07:00:00Z',
              },
            ],
          }
        case 'git.remote':
          return {
            name: 'origin',
            webUrl: 'https://github.com/acme/widgets',
            provider: 'github',
          }
        case 'github.listRuns':
          return { items: [RUN], total: 82 }
        case 'github.viewRun':
          return {
            run: RUN,
            jobs: [
              {
                id: 101,
                name: 'test (macos-latest)',
                status: 'completed',
                conclusion: 'failure',
                startedAt: '2026-09-29T12:10:00Z',
                completedAt: '2026-09-29T12:19:00Z',
                url: `${RUN.url}/job/101`,
                steps: [
                  {
                    number: 1,
                    name: 'Set up job',
                    status: 'completed',
                    conclusion: 'success',
                  },
                  {
                    number: 2,
                    name: 'make check',
                    status: 'completed',
                    conclusion: 'failure',
                  },
                ],
              },
            ],
          }
        default:
          return {
            ok: false,
            error: { message: `unexpected ${key}`, code: 'x' },
          }
      }
    },
    onCoreEvent: () => () => {},
    openExternal: vi.fn(async () => ({ ok: true })),
  }
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await nextTick()
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 60 && !check(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await settle()
  }
}

async function mount(page: Component, path: string): Promise<Router> {
  const stub = { render: () => h('div') }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/pulls/:owner?/:repo?/:number?',
        name: 'pulls',
        component: stub,
      },
      {
        path: '/github/issues/:owner?/:repo?/:number?',
        name: 'github-issues',
        component: stub,
      },
      {
        path: '/github/ci/:owner?/:repo?/:runId?',
        name: 'github-ci',
        component: stub,
      },
      { path: '/capabilities', name: 'capabilities', component: stub },
    ],
  })
  await router.push(path)
  await router.isReady()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(page) })
  app.use(router)
  app.provide(APP_CONTEXT_KEY, context as never)
  app.mount(container)
  await settle()
  return router
}

function $(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector)
}

function reads(key: string): Array<Dict | undefined> {
  return calls.filter(([name]) => name === key).map(([, input]) => input)
}

afterEach(() => {
  localStorage.clear()
  app?.unmount()
  app = null
  container?.remove()
  container = null
  context.boot.value = { plugins: [github()] }
  ghStatus = { available: true, login: 'octo-dev', version: '2.73.0' }
})

describe('GitHub › Issue', () => {
  it('lists issues with titles as text and opens one in place', async () => {
    installBridge()
    const router = await mount(GitHubIssuesPage, '/github/issues')
    await until(() => document.querySelectorAll('[data-issue]').length === 2)

    expect(reads('github.listIssues')).toEqual([{ filter: 'involved' }])
    expect($('[data-github-tabs]')).not.toBeNull()
    const row = $('[data-issue="acme/widgets#12"]')!
    expect(row.textContent).toContain(MARKUP)
    expect(row.querySelector('img')).toBeNull()
    // A label color that is not plain hex draws no style at all.
    const dots = [...document.querySelectorAll<HTMLElement>('.dot')]
    expect(dots.map((dot) => dot.getAttribute('style'))).toEqual([
      'background: rgb(215, 58, 74);',
      null,
    ])
    expect(document.body.textContent).toContain('共 57 个')

    row.click()
    await until(() => $('[data-issue-detail]')?.querySelector('h2') != null)
    expect(router.currentRoute.value.name).toBe('github-issues')
    expect(router.currentRoute.value.params).toMatchObject({
      owner: 'acme',
      repo: 'widgets',
      number: '12',
    })
    expect(reads('github.viewIssue')).toEqual([
      { repo: 'acme/widgets', number: 12 },
    ])
    const detail = $('[data-issue-detail="acme/widgets#12"]')!
    expect(detail.querySelector('h2')!.textContent).toBe(MARKUP)
    expect(detail.querySelector('img[src="x"]')).toBeNull()
    expect(detail.textContent).toContain('负责人：octo-dev')
    expect(detail.textContent).toContain('只显示最近 1 条')
  })

  it('changes the filter through the segments and remembers it', async () => {
    installBridge()
    await mount(GitHubIssuesPage, '/github/issues')
    await until(() => reads('github.listIssues').length === 1)
    $('[data-tab-id="owned"]')!.click()
    await until(() => reads('github.listIssues').length === 2)
    expect(reads('github.listIssues')[1]).toEqual({ filter: 'owned' })
    // Remembered for the next visit.
    app!.unmount()
    container!.remove()
    await mount(GitHubIssuesPage, '/github/issues')
    await until(() => reads('github.listIssues').length === 3)
    expect(reads('github.listIssues')[2]).toEqual({ filter: 'owned' })
  })

  it('reads nothing while the plugin is off and links to it', async () => {
    installBridge()
    context.boot.value = {
      plugins: [github({ enabled: false, activation: 'disabled' })],
    }
    const router = await mount(GitHubIssuesPage, '/github/issues')
    expect($('[data-github-disabled]')).not.toBeNull()
    expect($('[data-github-tabs]')).toBeNull()
    expect(calls).toEqual([])

    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('打开 GitHub 插件'),
    )!
    button.click()
    await until(() => router.currentRoute.value.name === 'capabilities')
    expect(router.currentRoute.value.query).toEqual({
      plugin: 'github',
      scope: 'managed',
    })
  })

  it('shows the gh state and reads nothing while gh is logged out', async () => {
    installBridge()
    ghStatus = {
      available: false,
      reason: 'gh_unauthenticated',
      version: '2.73.0',
    }
    await mount(GitHubIssuesPage, '/github/issues')
    await until(() => $('[data-reason]') != null)
    expect($('[data-reason]')!.dataset.reason).toBe('gh_unauthenticated')
    expect(document.body.textContent).toContain('GitHub CLI 尚未登录')
    expect(reads('github.listIssues')).toEqual([])
  })
})

describe('GitHub › CI', () => {
  it("starts from the project's origin and shows a run's jobs", async () => {
    installBridge()
    const router = await mount(GitHubRunsPage, '/github/ci')
    await until(() => document.querySelectorAll('[data-run]').length === 1)

    expect(reads('git.remote')).toEqual([{ sessionId: 'session-1' }])
    expect(reads('github.listRuns')).toEqual([{ repo: 'acme/widgets' }])
    const row = $('[data-run="36566264518"]')!
    expect(row.textContent).toContain('失败')
    expect(row.textContent).toContain('ci #77 · main · 推送 · octo-dev')

    row.click()
    await until(() => $('[data-job="101"]') != null)
    expect(router.currentRoute.value.params).toMatchObject({
      owner: 'acme',
      repo: 'widgets',
      runId: '36566264518',
    })
    expect(reads('github.viewRun')).toEqual([
      { repo: 'acme/widgets', runId: 36566264518 },
    ])
    const job = $('[data-job="101"]')!
    expect(job.textContent).toContain('test (macos-latest)')
    expect(job.textContent).toContain('9 分钟')
    expect(
      [...job.querySelectorAll<HTMLElement>('.step')].map(
        (step) => step.dataset.outcome,
      ),
    ).toEqual(['ok', 'error'])
  })

  it('takes a typed repository and refuses a bad name without reading', async () => {
    installBridge()
    const router = await mount(GitHubRunsPage, '/github/ci')
    await until(() => reads('github.listRuns').length === 1)
    const input = $('input[aria-label="仓库"]') as HTMLInputElement
    input.value = '--help'
    input.dispatchEvent(new Event('input'))
    $('form')!.dispatchEvent(new Event('submit'))
    await settle()
    expect(document.body.textContent).toContain(
      '请输入 owner/name 形式的仓库名。',
    )
    expect(reads('github.listRuns')).toHaveLength(1)

    input.value = 'acme/tools'
    input.dispatchEvent(new Event('input'))
    $('form')!.dispatchEvent(new Event('submit'))
    await until(() => reads('github.listRuns').length === 2)
    expect(router.currentRoute.value.params).toMatchObject({
      owner: 'acme',
      repo: 'tools',
    })
    expect(reads('github.listRuns')[1]).toEqual({ repo: 'acme/tools' })
  })
})

describe('Pull Request page', () => {
  it('carries the GitHub tabs only while the plugin is on', async () => {
    installBridge()
    await mount(PullRequestsPage, '/pulls')
    expect($('h1')!.textContent).toBe('GitHub')
    expect($('[data-github-tabs]')).not.toBeNull()
    app!.unmount()
    container!.remove()

    context.boot.value = {
      plugins: [github({ enabled: false, activation: 'disabled' })],
    }
    await mount(PullRequestsPage, '/pulls')
    expect($('h1')!.textContent).toBe('Pull Request')
    expect($('[data-github-tabs]')).toBeNull()
  })
})
