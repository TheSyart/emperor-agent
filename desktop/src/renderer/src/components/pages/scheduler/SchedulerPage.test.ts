// @vitest-environment jsdom
/**
 * SchedulerPage wiring: the status tabs and search over boot.scheduler, row
 * copy, the ⋯ menu (run / pause / resume / delete with its confirmation;
 * protected jobs cannot be deleted), the edit dialog and the 「创建 ▾」 menu.
 */
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import type { SchedulerJob, SchedulerPayload } from '../../../types'
import SchedulerPage from './SchedulerPage.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../../api/http', () => ({ core }))

const HOUR = 3_600_000
const NOW = Date.now()

function job(overrides: Partial<SchedulerJob>): SchedulerJob {
  return {
    id: 'job',
    name: 'Job',
    enabled: true,
    schedule: { kind: 'every', everyMs: 2 * HOUR },
    payload: { kind: 'agent_turn', message: 'Run' },
    state: { nextRunAtMs: NOW + 2 * HOUR },
    ...overrides,
  }
}

function payload(jobs: SchedulerJob[]): SchedulerPayload {
  return {
    status: {
      running: true,
      jobs: jobs.length,
      enabled: jobs.filter((item) => item.enabled).length,
      nextRunAtMs: null,
    },
    jobs,
  }
}

const JOBS = [
  job({
    id: 'job_digest',
    name: '每日摘要',
    schedule: { kind: 'cron', expr: '0 18 * * 5', tz: 'UTC' },
    state: { nextRunAtMs: NOW + 3 * 24 * HOUR },
  }),
  job({ id: 'job_weekly', name: '周报整理', enabled: false }),
  job({
    id: 'job_once',
    name: '发布提醒',
    enabled: false,
    schedule: { kind: 'at', atMs: NOW - 24 * HOUR },
    state: { lastRunAtMs: NOW - 24 * HOUR, nextRunAtMs: null },
  }),
  job({
    id: 'memory-maintenance',
    name: 'Memory maintenance',
    protected: true,
    payload: { kind: 'system_event', message: 'memory-maintenance' },
  }),
]

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let container: HTMLDivElement | null = null
let app: App | null = null
let ctx: ReturnType<typeof makeContext>

function makeContext() {
  return {
    boot: ref<{ scheduler: SchedulerPayload }>({ scheduler: payload(JOBS) }),
    showToast: vi.fn(),
    runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
  }
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  ctx = makeContext()
  app = createApp(() => h(SchedulerPage))
  app.provide(APP_CONTEXT_KEY, ctx as never)
  app.mount(container)
  await flush()
}

function rows(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('.job-row[data-job-id]'),
  ].map((row) => row.dataset.jobId ?? '')
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `.job-row[data-job-id="${id}"]`,
  )
  if (!el) throw new Error(`no row ${id}`)
  return el
}

function tab(label: string): HTMLButtonElement {
  const el = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((item) => item.textContent?.trim().startsWith(label))
  if (!el) throw new Error(`no tab ${label}`)
  return el
}

function menuItem(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    `[role="menu"] [data-menu-item="${id}"]`,
  )
  if (!el) throw new Error(`no menu item ${id}`)
  return el
}

async function openMenu(id: string) {
  row(id).querySelector<HTMLButtonElement>('[data-action="job-menu"]')!.click()
  await flush()
}

beforeEach(() => {
  core.mockImplementation(async (op: string, id?: string) => {
    if (op === 'scheduler.get') return payload(JOBS)
    const next = JOBS.map((item) =>
      item.id !== id
        ? item
        : op === 'scheduler.pauseJob'
          ? { ...item, enabled: false }
          : op === 'scheduler.resumeJob'
            ? { ...item, enabled: true }
            : item,
    )
    if (op === 'scheduler.deleteJob')
      return {
        deleted: true,
        scheduler: payload(JOBS.filter((item) => item.id !== id)),
      }
    return {
      job: next.find((item) => item.id === id),
      scheduler: payload(next),
    }
  })
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  core.mockReset()
})

describe('SchedulerPage', () => {
  it('loads the jobs and lists them with Chinese schedule copy', async () => {
    await mount()
    expect(core).toHaveBeenCalledWith('scheduler.get')
    expect(rows()).toEqual([
      'job_digest',
      'job_weekly',
      'job_once',
      'memory-maintenance',
    ])
    expect(row('job_digest').textContent).toContain(
      '星期五（时间：18:00，UTC） · 下次运行 3天后',
    )
    expect(row('job_weekly').textContent).toContain('每 2 小时 · 已暂停')
    expect(row('job_once').textContent).toContain('一次 · 已完成')
    expect(row('job_once').dataset.state).toBe('completed')
  })

  it('filters by the status tabs and the search field', async () => {
    await mount()
    expect(tab('全部').textContent).toContain('4')
    tab('已开启').click()
    await nextTick()
    expect(rows()).toEqual(['job_digest', 'memory-maintenance'])
    tab('已暂停').click()
    await nextTick()
    expect(rows()).toEqual(['job_weekly'])
    tab('已完成').click()
    await nextTick()
    expect(rows()).toEqual(['job_once'])

    tab('全部').click()
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="搜索已安排任务"]',
    )!
    search.value = '周报'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(rows()).toEqual(['job_weekly'])
  })

  it('pauses, resumes and runs a job from the row menu', async () => {
    await mount()
    await openMenu('job_digest')
    menuItem('pause').click()
    await flush()
    expect(core).toHaveBeenCalledWith('scheduler.pauseJob', 'job_digest')
    expect(ctx.showToast).toHaveBeenCalledWith('任务已暂停')
    expect(row('job_digest').dataset.state).toBe('paused')

    await openMenu('job_weekly')
    menuItem('resume').click()
    await flush()
    expect(core).toHaveBeenCalledWith('scheduler.resumeJob', 'job_weekly')

    await openMenu('job_weekly')
    menuItem('run').click()
    await flush()
    expect(core).toHaveBeenCalledWith('scheduler.runJob', 'job_weekly')
  })

  it('deletes after a confirmation and never deletes protected jobs', async () => {
    await mount()
    await openMenu('memory-maintenance')
    expect(menuItem('delete').disabled).toBe(true)
    menuItem('delete').click()
    await flush()
    expect(document.querySelector('[data-action="confirm-delete"]')).toBeNull()

    document.body.click()
    await openMenu('job_weekly')
    menuItem('delete').click()
    await flush()
    expect(core).not.toHaveBeenCalledWith('scheduler.deleteJob', 'job_weekly')
    document
      .querySelector<HTMLButtonElement>('[data-action="confirm-delete"]')!
      .click()
    await flush()
    expect(core).toHaveBeenCalledWith('scheduler.deleteJob', 'job_weekly')
    expect(rows()).not.toContain('job_weekly')
  })

  it('opens a row in the edit dialog; protected jobs get no form', async () => {
    await mount()
    row('job_digest').querySelector<HTMLButtonElement>('.main')!.click()
    await flush()
    const dialog = document.querySelector(
      '[data-testid="scheduler-job-dialog"]',
    )
    expect(dialog?.getAttribute('data-mode')).toBe('edit')
    expect(
      dialog?.querySelector<HTMLInputElement>('input[placeholder]')?.value,
    ).toBe('每日摘要')
    expect(document.querySelector('[data-action="save-job"]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('.ds-modal .close')!.click()
    await flush()

    row('memory-maintenance').querySelector<HTMLButtonElement>('.main')!.click()
    await flush()
    expect(document.body.textContent).toContain('受保护的系统任务')
    expect(document.querySelector('[data-action="save-job"]')).toBeNull()
    expect(document.querySelector('[data-action="delete-job"]')).toBeNull()
    expect(document.querySelector('[data-action="run-job"]')).not.toBeNull()
  })

  it('creates from a template in the 「创建」 menu', async () => {
    await mount()
    document.querySelector<HTMLButtonElement>('[data-action="create"]')!.click()
    await flush()
    document
      .querySelector<HTMLButtonElement>('[data-menu-item="weekly-review"]')!
      .click()
    await flush()
    const dialog = document.querySelector(
      '[data-testid="scheduler-job-dialog"]',
    )
    expect(dialog?.getAttribute('data-mode')).toBe('create')
    core.mockResolvedValueOnce({
      job: job({ id: 'job_new', name: '每周回顾' }),
      scheduler: payload(JOBS),
    })
    document
      .querySelector<HTMLButtonElement>('[data-action="create-job"]')!
      .click()
    await flush()
    expect(core).toHaveBeenCalledWith(
      'scheduler.createJob',
      expect.objectContaining({
        name: '每周回顾',
        schedule: expect.objectContaining({ kind: 'cron', expr: '0 18 * * 5' }),
      }),
    )
    expect(ctx.showToast).toHaveBeenCalledWith('定时任务已创建：每周回顾')
  })
})
