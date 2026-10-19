// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import type { DiagnosticsPayload } from '../../types'
import DiagnosticsSection from './DiagnosticsSection.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'

const { core, openPath } = vi.hoisted(() => ({
  core: vi.fn(),
  openPath: vi.fn(),
}))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../../api/backend', () => ({ openPath }))

let app: App | null = null
let container: HTMLDivElement | null = null

/** Runtime fine but for one stale-config warning; pet modules missing. */
const payload: DiagnosticsPayload = {
  root: '/Users/me/app',
  paths: {
    runtimeRoot: '/Users/me/app',
    stateRoot: '/Users/me/.emperor',
    stateRootSource: 'default',
    sessionsRoot: '/Users/me/.emperor/sessions',
  },
  workspacePolicy: { workspaceRoot: '/Users/me/code/site' },
  modelConfig: { status: 'ok', exists: true, models: 2 },
  localConfig: { status: 'ok', exists: true },
  scheduler: { jobsFile: 'memory/scheduler/jobs.json' },
  runtime: { events: 3, needsRotation: true },
  dependencies: {
    nodeRuntime: true,
    desktopRenderer: true,
    desktopPetModules: true,
  },
} as never

const environment = {
  status: {
    platform: 'darwin',
    arch: 'arm64',
    tools: [
      {
        id: 'git',
        category: 'base',
        required: true,
        reason: '基础文件能力需要 Git',
        status: 'ready',
        detectedVersion: '2.55.0',
        versionSummary: 'git version 2.55.0',
        requiredVersion: '>=2.40.0',
      },
      {
        id: 'python',
        category: 'skill',
        required: true,
        reason: 'blocked-visual Skill 需要 Python',
        status: 'missing',
        detectedVersion: null,
        versionSummary: null,
        requiredVersion: '>=3.12.0',
      },
    ],
  },
  recentJobs: [],
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(DiagnosticsSection) })
  app.provide(APP_CONTEXT_KEY, {
    boot: ref(null),
    runSafely: async (task: () => Promise<void>) => task(),
  } as never)
  app.provide(SETTINGS_HEADER_KEY, createSettingsHeader())
  app.mount(container)
  await settle()
  return container
}

function card(root: HTMLElement, id: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(
    `[data-diagnostic-card="${id}"]`,
  )
  if (!found) throw new Error(`no card ${id}`)
  return found
}

async function open(root: HTMLElement, id: string): Promise<HTMLElement> {
  card(root, id).querySelector<HTMLButtonElement>('.head-text')!.click()
  await settle()
  return card(root, id)
}

function rowOf(scope: HTMLElement, id: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

beforeEach(() => {
  core.mockImplementation(async (key: string) => {
    if (key === 'diagnostics.get') return payload
    if (key === 'environment.getStatus') return environment
    return undefined
  })
  openPath.mockResolvedValue(undefined)
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe('诊断', () => {
  it('opens with one overview card: a conclusion and what needs attention, no number tiles', async () => {
    const root = await mount()
    const overview = root.querySelector<HTMLElement>(
      '[data-testid="diagnostics-overview"]',
    )!
    expect(overview.classList.contains('ds-settings-card')).toBe(true)
    expect(root.querySelector('.ds-metric')).toBeNull()
    // No lead-in: the runtime root moved into 存储路径.
    expect(root.querySelector('.ds-settings-section .intro')).toBeNull()
    expect(
      [...overview.querySelectorAll('.summary .ds-badge')].map((badge) =>
        badge.textContent?.trim(),
      ),
    ).toEqual(['2 项需要关注'])
    expect(overview.querySelector('.conclusion')?.textContent).toBe(
      '其余都正常',
    )
    const issues = [...overview.querySelectorAll<HTMLElement>('[data-issue]')]
    expect(issues.map((issue) => issue.dataset.issue)).toEqual([
      'runtime-events',
      'environment-python',
    ])
    expect(issues[1]!.textContent).toContain('环境工具 · python')
    expect(issues[1]!.textContent).toContain('缺失')
  })

  it('says all is well in one line when nothing needs attention', async () => {
    core.mockImplementation(async (key: string) => {
      if (key === 'diagnostics.get')
        return { ...payload, runtime: { events: 3, needsRotation: false } }
      if (key === 'environment.getStatus')
        return {
          ...environment,
          status: {
            ...environment.status,
            tools: [environment.status.tools[0]],
          },
        }
      return undefined
    })
    const root = await mount()
    const overview = root.querySelector<HTMLElement>(
      '[data-testid="diagnostics-overview"]',
    )!
    expect(overview.querySelector('.summary')?.textContent).toContain(
      '运行正常',
    )
    expect(overview.querySelector('[data-issue]')).toBeNull()
  })

  it('marks only the cards that need attention', async () => {
    const root = await mount()
    expect(
      [...root.querySelectorAll<HTMLElement>('[data-diagnostic-card]')].map(
        (item) => item.dataset.diagnosticCard,
      ),
    ).toEqual(['runtime', 'environment', 'desktop', 'paths', 'config'])
    const badges = (id: string) =>
      [...card(root, id).querySelectorAll('.head .ds-badge')].map(
        (badge) => badge.textContent?.trim(),
      )
    expect(badges('runtime')).toEqual(['1 项需要关注'])
    expect(badges('environment')).toEqual(['1 项需要关注'])
    expect(badges('desktop')).toEqual([])
    expect(badges('paths')).toEqual([])
    expect(badges('config')).toEqual([])
  })

  it('keeps the runtime root in 存储路径, path by path', async () => {
    const root = await mount()
    expect(card(root, 'paths').textContent).toContain('含运行根目录')
    const paths = await open(root, 'paths')
    const first = paths.querySelector<HTMLElement>('[data-row]')!
    expect(first.dataset.row).toBe('runtime-root')
    expect(first.textContent).toContain('运行根目录')
    expect(first.querySelector('.value')?.textContent?.trim()).toBe('~/app')
    // The same folder is the built-in resources: one row, not two.
    expect(
      paths.querySelector('[data-row="runtime-resources-root"]'),
    ).toBeNull()
    expect(
      rowOf(paths, 'sessions-path')
        .querySelector('.value')
        ?.textContent?.trim(),
    ).toBe('~/.emperor/sessions')
  })

  it('shows a normal row as its value, and says why on a row that needs attention', async () => {
    const root = await mount()
    const runtime = await open(root, 'runtime')
    expect(runtime.querySelector('.ds-badge.value')).toBeNull()
    const fine = rowOf(runtime, 'scheduler-store')
    expect(fine.querySelector('.value')?.textContent?.trim()).toBe('正常')
    expect(fine.querySelector('.description')).toBeNull()
    expect(fine.querySelector<HTMLElement>('.value')?.dataset.tone).toBe('ok')
    const stale = rowOf(runtime, 'runtime-events')
    expect(stale.querySelector<HTMLElement>('.value')?.dataset.tone).toBe(
      'warn',
    )
    expect(stale.querySelector('.description')?.textContent).toContain(
      '需要轮转',
    )
    const tools = await open(root, 'environment')
    expect(
      tools
        .querySelector('[data-testid="environment-tool-git"] .value')
        ?.textContent?.trim(),
    ).toBe('2.55.0')
    expect(
      tools.querySelector(
        '[data-testid="environment-tool-python"] .description',
      )?.textContent,
    ).toContain('blocked-visual Skill 需要 Python')
  })

  it('opens the card of an issue and brings it into view', async () => {
    const root = await mount()
    root
      .querySelector<HTMLButtonElement>('[data-issue="environment-python"]')!
      .click()
    await settle()
    expect(
      card(root, 'environment')
        .querySelector('.head-text')
        ?.getAttribute('aria-expanded'),
    ).toBe('true')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('puts a failed request in a notice at the top', async () => {
    core.mockImplementation(async (key: string) => {
      if (key === 'diagnostics.get') throw new Error('Core 没有响应')
      if (key === 'environment.getStatus') throw new Error('PATH 读不到')
      return undefined
    })
    const root = await mount()
    const notices = [
      ...root.querySelectorAll<HTMLElement>('.ds-notice'),
    ]
    expect(notices.map((notice) => notice.dataset.tone)).toEqual([
      'error',
      'error',
    ])
    expect(notices[0]!.textContent).toContain('诊断请求失败')
    expect(notices[0]!.textContent).toContain('Core 没有响应')
    expect(notices[1]!.textContent).toContain('环境检测失败')
    expect(notices[1]!.textContent).toContain('PATH 读不到')
    expect(
      root.querySelector('.ds-settings-section > .body')?.firstElementChild,
    ).toBe(notices[0])
    expect(root.querySelector('.diag-alert, .env-alert')).toBeNull()
  })
})
