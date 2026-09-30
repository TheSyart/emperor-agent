// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileView } from '@emperor/core/runtime-contract'
import ImportDialog from './ImportDialog.vue'

const { fetchBrowserImportSources, runBrowserImport, vaultStatus } = vi.hoisted(
  () => ({
    fetchBrowserImportSources: vi.fn(),
    runBrowserImport: vi.fn(),
    vaultStatus: vi.fn(),
  }),
)
vi.mock('../../../api/backend', () => ({
  fetchBrowserImportSources,
  runBrowserImport,
  vaultStatus,
}))
const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../../api/http', () => ({ core }))

let app: App | null = null
let container: HTMLDivElement | null = null

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(ImportDialog, { open: true }) })
  app.mount(container)
  await settle()
}

function testid(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

const chromeReady = {
  browsers: [
    {
      browser: 'chrome' as const,
      name: 'Google Chrome',
      installed: true,
      running: false,
      profiles: [
        { dir: 'Default', name: '个人' },
        { dir: 'Profile 1', name: '工作' },
      ],
    },
    {
      browser: 'edge' as const,
      name: 'Microsoft Edge',
      installed: true,
      running: false,
      profiles: [{ dir: 'Default', name: '默认' }],
    },
  ],
}

const profiles = [
  { profileId: 'temporary', name: '临时', kind: 'temporary', openTargets: 0 },
  {
    profileId: 'p_0123456789ab',
    name: '工作',
    kind: 'persistent',
    openTargets: 1,
  },
] as BrowserProfileView[]

beforeEach(() => {
  fetchBrowserImportSources.mockResolvedValue(chromeReady)
  runBrowserImport.mockResolvedValue({ ok: true, passwords: 7, sites: 4 })
  vaultStatus.mockResolvedValue({ available: true, locked: false })
  core.mockImplementation(async (key: string) =>
    key === 'computerUse.listProfiles' ? profiles : {},
  )
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  vi.clearAllMocks()
})

describe('ImportDialog', () => {
  it('imports passwords and cookies into the default profile, then reports counts', async () => {
    await mount()
    testid('import-run')!.click()
    await settle()
    expect(runBrowserImport).toHaveBeenCalledWith({
      browser: 'chrome',
      profileDir: 'Default',
      passwords: true,
      cookies: true,
      targetProfileId: 'p_0123456789ab',
    })
    expect(testid('import-result')?.textContent).toContain(
      '导入了 7 个密码、4 个网站的登录',
    )
  })

  it('shows the close-it-first warning and disables import while the browser runs', async () => {
    fetchBrowserImportSources.mockResolvedValue({
      browsers: [{ ...chromeReady.browsers[0], running: true }],
    })
    await mount()
    expect(testid('import-running')?.textContent).toContain(
      '请完全关闭 Google Chrome',
    )
    expect((testid('import-run') as HTMLButtonElement).disabled).toBe(true)
    expect(runBrowserImport).not.toHaveBeenCalled()
  })

  it('drops the cookie target when only passwords are chosen', async () => {
    await mount()
    testid('import-cookies')!.click() // turn cookies off
    await settle()
    testid('import-run')!.click()
    await settle()
    expect(runBrowserImport).toHaveBeenCalledWith({
      browser: 'chrome',
      profileDir: 'Default',
      passwords: true,
      cookies: false,
    })
  })

  it('prompts to unlock a locked vault and does not import', async () => {
    vaultStatus.mockResolvedValue({ available: true, locked: true })
    await mount()
    testid('import-run')!.click()
    await settle()
    expect(testid('import-error')?.textContent).toContain('解锁')
    expect(runBrowserImport).not.toHaveBeenCalled()
  })

  it('explains when there is no browser to import from', async () => {
    fetchBrowserImportSources.mockResolvedValue({ browsers: [] })
    await mount()
    // The Modal teleports its body to document.body.
    expect(document.body.textContent).toContain('没有可导入的浏览器')
  })
})
