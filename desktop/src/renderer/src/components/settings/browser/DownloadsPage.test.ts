// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentDownloadView,
  UserDownloadView,
} from '../../../../../shared/ipc-contract'
import DownloadsPage from './DownloadsPage.vue'

const NOW = new Date(2026, 8, 30, 15, 0).getTime()
const AT = new Date(2026, 8, 30, 14, 5).getTime()

let app: App | null = null
let container: HTMLDivElement | null = null
let user: UserDownloadView[]
let agent: AgentDownloadView[]
let pushed: Array<(view: UserDownloadView) => void>
let bridge: Record<string, ReturnType<typeof vi.fn>>

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(DownloadsPage) })
  app.mount(container)
  await settle()
  return container
}

function group(root: HTMLElement, title: string): HTMLElement {
  const found = [
    ...root.querySelectorAll<HTMLElement>('.ds-settings-group'),
  ].find((item) => item.querySelector('.head .title')?.textContent === title)
  if (!found) throw new Error(`no group ${title}`)
  return found
}

function rowOf(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-download="${id}"]`)!
}

function buttons(row: HTMLElement): string[] {
  return [...row.querySelectorAll('button')].map(
    (button) => button.textContent?.trim() ?? '',
  )
}

function click(row: HTMLElement, text: string): void {
  const found = [...row.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  found.click()
}

const mine = (patch: Partial<UserDownloadView>): UserDownloadView => ({
  id: 'ud_0123456789ab',
  name: 'report.csv',
  site: 'https://news.example',
  time: AT,
  state: 'completed',
  bytes: 24,
  exists: true,
  ...patch,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  user = [
    mine({}),
    mine({
      id: 'ud_0123456789ac',
      name: 'setup.dmg',
      state: 'blocked',
      reason: 'executable',
      bytes: 0,
      exists: undefined,
    }),
    mine({
      id: 'ud_0123456789ad',
      name: 'video.mp4',
      state: 'progressing',
      bytes: 42,
      totalBytes: 100,
      exists: undefined,
    }),
    mine({ id: 'ud_0123456789ae', name: 'gone.csv', exists: false }),
  ]
  agent = [
    {
      id: 'dl_0123456789ab',
      name: 'invoice.pdf',
      site: 'https://billing.example',
      sessionId: 's1',
      time: AT,
      bytes: 2048,
      exists: true,
    },
    {
      id: 'dl_0123456789ac',
      name: 'old.csv',
      site: '',
      sessionId: null,
      time: AT,
      bytes: 3,
      exists: false,
    },
  ]
  pushed = []
  bridge = {
    browserDownloads: vi.fn(async () => ({ user, agent })),
    openBrowserDownload: vi.fn(async () => ({ ok: true })),
    revealBrowserDownload: vi.fn(async () => ({ ok: true })),
    removeBrowserDownload: vi.fn(async (id: string) => {
      user = user.filter((entry) => entry.id !== id)
      return { ok: true }
    }),
    onBrowserDownload: vi.fn((listener: (view: UserDownloadView) => void) => {
      pushed.push(listener)
      return () => undefined
    }),
    agentDownloadReveal: vi.fn(async () => ({ ok: true })),
    agentDownloadMove: vi.fn(async () => ({
      ok: true,
      path: '/work/downloads/invoice.pdf',
    })),
    agentDownloadSaveAs: vi.fn(async () => ({ ok: false, cancelled: true })),
  }
  ;(window as unknown as { emperor: unknown }).emperor = bridge
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  delete (window as unknown as { emperor?: unknown }).emperor
  vi.useRealTimers()
})

describe('下载历史记录', () => {
  it('lists your downloads and Emperor’s in two groups', async () => {
    const root = await mount()
    expect(
      [...root.querySelectorAll('.ds-settings-group > .head .title')].map(
        (title) => title.textContent,
      ),
    ).toEqual(['你的下载', 'Emperor 的下载'])
    const rows = [
      ...group(root, '你的下载').querySelectorAll('.ds-settings-row'),
    ]
    expect(
      rows.map((row) => [
        row.querySelector('.title')?.textContent?.trim(),
        row.querySelector('.description')?.textContent?.trim(),
      ]),
    ).toEqual([
      ['report.csv', 'news.example · 9月30日 14:05 · 24 B'],
      ['setup.dmg', 'news.example · 9月30日 14:05 · 已拦截：可执行文件'],
      ['video.mp4', 'news.example · 9月30日 14:05 · 正在下载 42%'],
      ['gone.csv', 'news.example · 9月30日 14:05 · 文件已移走或删除'],
    ])
    expect(
      rowOf(root, 'dl_0123456789ab').querySelector('.description')?.textContent,
    ).toContain('billing.example · 9月30日 14:05 · 2.0 KB')
  })

  it('offers only what each of your downloads allows', async () => {
    const root = await mount()
    expect(buttons(rowOf(root, 'ud_0123456789ab'))).toEqual([
      '打开',
      '在访达中显示',
      '移除',
    ])
    expect(buttons(rowOf(root, 'ud_0123456789ac'))).toEqual(['移除'])
    expect(buttons(rowOf(root, 'ud_0123456789ad'))).toEqual([])
    expect(buttons(rowOf(root, 'ud_0123456789ae'))).toEqual(['移除'])
  })

  it('opens, reveals and removes by id, keeping the file', async () => {
    const root = await mount()
    click(rowOf(root, 'ud_0123456789ab'), '打开')
    await settle()
    click(rowOf(root, 'ud_0123456789ab'), '在访达中显示')
    await settle()
    expect(bridge.openBrowserDownload).toHaveBeenCalledWith('ud_0123456789ab')
    expect(bridge.revealBrowserDownload).toHaveBeenCalledWith('ud_0123456789ab')
    click(rowOf(root, 'ud_0123456789ac'), '移除')
    await settle()
    expect(bridge.removeBrowserDownload).toHaveBeenCalledWith('ud_0123456789ac')
    expect(rowOf(root, 'ud_0123456789ac')).toBeNull()
  })

  it('says why an action failed', async () => {
    bridge.openBrowserDownload!.mockResolvedValueOnce({
      ok: false,
      error: '没有可以打开它的应用',
    })
    const root = await mount()
    click(rowOf(root, 'ud_0123456789ab'), '打开')
    await settle()
    // One notice at the top of the page, in the error tone.
    const notice = root.querySelector<HTMLElement>('.ds-settings-notice')
    expect(notice?.dataset.tone).toBe('error')
    expect(notice?.getAttribute('role')).toBe('alert')
    expect(notice?.textContent).toContain('没有可以打开它的应用')
    expect(
      root.querySelector('.ds-settings-section > .body')?.firstElementChild,
    ).toBe(notice)
  })

  it('says what the page is in one short sentence', async () => {
    const root = await mount()
    const intro =
      root.querySelector('.ds-settings-section .intro')?.textContent?.trim() ??
      ''
    expect(intro).not.toBe('')
    expect(intro.split(/[。！？；]/).filter(Boolean)).toHaveLength(1)
    expect(intro.length).toBeLessThanOrEqual(42)
  })

  it('reveals, moves and saves Emperor’s downloads through the inbox', async () => {
    const root = await mount()
    const row = rowOf(root, 'dl_0123456789ab')
    expect(buttons(row)).toEqual(['在访达中显示', '移到工作区', '另存为…'])
    click(row, '在访达中显示')
    await settle()
    click(rowOf(root, 'dl_0123456789ab'), '移到工作区')
    await settle()
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      '已移到工作区',
    )
    expect(
      root.querySelector<HTMLElement>('.ds-settings-notice')?.dataset.tone,
    ).toBe('info')
    click(rowOf(root, 'dl_0123456789ab'), '另存为…')
    await settle()
    expect(bridge.agentDownloadReveal).toHaveBeenCalledWith('dl_0123456789ab')
    expect(bridge.agentDownloadMove).toHaveBeenCalledWith('dl_0123456789ab')
    expect(bridge.agentDownloadSaveAs).toHaveBeenCalledWith('dl_0123456789ab')
    // No conversation, or no file: nothing to do.
    expect(buttons(rowOf(root, 'dl_0123456789ac'))).toEqual([])
    expect(
      rowOf(root, 'dl_0123456789ac').querySelector('.description')?.textContent,
    ).toContain('文件已移走或删除')
  })

  it('shows 暂无 for an empty list', async () => {
    user = []
    agent = []
    const root = await mount()
    for (const title of ['你的下载', 'Emperor 的下载'])
      expect(group(root, title).textContent).toContain('暂无')
  })

  it('follows your downloads as main reports them', async () => {
    user = []
    const root = await mount()
    for (const listener of pushed)
      listener(mine({ state: 'progressing', bytes: 0, totalBytes: 0 }))
    await settle()
    expect(rowOf(root, 'ud_0123456789ab').textContent).toContain('正在下载')
    for (const listener of pushed) listener(mine({}))
    await settle()
    expect(rowOf(root, 'ud_0123456789ab').textContent).toContain('24 B')
    expect(rowOf(root, 'ud_0123456789ab').textContent).not.toContain('正在下载')
    expect(
      group(root, '你的下载').querySelectorAll('[data-download]'),
    ).toHaveLength(1)
  })
})
