// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StorageSection from './StorageSection.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'

// 设置 › 高级 › 存储 (KRN-12): what Emperor Home holds by category, and
// 「清理」 (after a confirm) saying what it freed.

const { core, confirm, backup } = vi.hoisted(() => ({
  core: vi.fn(),
  confirm: vi.fn(),
  backup: {
    planHomeBackup: vi.fn(),
    exportHomeBackup: vi.fn(),
    revealHomeBackup: vi.fn(),
    openHomeBackup: vi.fn(),
    restoreHomeBackup: vi.fn(),
    discardHomeBackup: vi.fn(),
  },
}))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../ui/confirm', () => ({ confirm }))
vi.mock('../../api/homeBackup', async (load) => ({
  ...(await load<typeof import('../../api/homeBackup')>()),
  ...backup,
}))

const MB = 1024 * 1024

function usage(spill = 30 * MB) {
  const categories = [
    { id: 'sessions', bytes: 120 * MB },
    { id: 'attachments', bytes: 40 * MB },
    { id: 'spill', bytes: spill },
    { id: 'memoryVersions', bytes: 2 * MB },
    { id: 'ledger', bytes: 1.5 * MB },
    { id: 'delegations', bytes: 8 * MB },
    { id: 'other', bytes: 300 * MB },
  ]
  return {
    root: '/Users/me/.emperor',
    total: categories.reduce((sum, item) => sum + item.bytes, 0),
    categories,
    measuredAt: 0,
  }
}

const none = { removed: 0, bytes: 0 }

let app: App | null = null
let root: HTMLDivElement | null = null
let header = createSettingsHeader()

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(StorageSection) })
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(root)
  await settle()
  return root
}

function row(element: HTMLElement, id: string): string {
  return (
    element
      .querySelector(`[data-storage-category="${id}"]`)
      ?.textContent?.replace(/\s+/g, ' ')
      .trim() ?? ''
  )
}

beforeEach(() => {
  header = createSettingsHeader()
  core.mockReset()
  confirm.mockReset()
  for (const mock of Object.values(backup)) mock.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  root?.remove()
  root = null
  document.body.innerHTML = ''
})

describe('设置 › 高级 › 存储', () => {
  it('shows the total and every category with its size', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'storage.usage') return usage()
      throw new Error(`unexpected ${operation}`)
    })
    const element = await mount()
    expect(row(element, 'total')).toContain('501.5 MB')
    expect(row(element, 'sessions')).toContain('会话')
    expect(row(element, 'sessions')).toContain('120 MB')
    expect(row(element, 'spill')).toContain('溢出文件')
    expect(row(element, 'spill')).toContain('30 MB')
    expect(row(element, 'ledger')).toContain('1.5 MB')
    expect(row(element, 'other')).toContain('300 MB')
    expect(element.querySelectorAll('[data-storage-category]').length).toBe(8)
    expect(header.actions.value.map((action) => action.id)).toEqual(['refresh'])
  })

  it('cleans after a confirm and says what it freed', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'storage.usage') return usage()
      if (operation === 'storage.clean')
        return {
          report: {
            sessions: none,
            spill: { removed: 4, bytes: 25 * MB },
            memoryVersions: none,
            delegations: none,
            freedBytes: 25 * MB,
            errors: [],
          },
          usage: usage(5 * MB),
        }
      throw new Error(`unexpected ${operation}`)
    })
    confirm.mockResolvedValue(true)
    const element = await mount()
    element.querySelector<HTMLButtonElement>('[data-storage-clean]')!.click()
    await settle()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('清理') }),
    )
    expect(core).toHaveBeenCalledWith('storage.clean')
    expect(element.textContent).toContain('已释放 25 MB：溢出文件 4 项。')
    expect(row(element, 'spill')).toContain('5 MB')
  })

  it('does not clean when the confirm is cancelled', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'storage.usage') return usage()
      throw new Error(`unexpected ${operation}`)
    })
    confirm.mockResolvedValue(false)
    const element = await mount()
    element.querySelector<HTMLButtonElement>('[data-storage-clean]')!.click()
    await settle()
    expect(core).not.toHaveBeenCalledWith('storage.clean')
  })

  it('says why the sizes could not be read', async () => {
    core.mockRejectedValue(new Error('磁盘不可读'))
    const element = await mount()
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      '磁盘不可读',
    )
  })
})

// REL-03: 备份与恢复, and the files a newer Emperor wrote.
function versions(files: Array<Record<string, unknown>> = []) {
  return {
    appVersion: '0.2.0',
    lastRunVersion: '0.2.0',
    previousRunVersion: '0.2.0',
    downgradedFrom: null,
    dataVersion: 1,
    supportedDataVersion: 1,
    files,
    lastRestore: null,
  }
}

describe('设置 › 高级 › 存储 › 备份与恢复 (REL-03)', () => {
  it('names the files a newer Emperor wrote, read-only here', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'storage.usage') return usage()
      if (operation === 'storage.versions')
        return versions([
          {
            id: 'settings',
            path: 'settings.json',
            label: '设置',
            owner: 'core',
            state: 'newer',
            version: 3,
            supported: 1,
          },
          {
            id: 'modelConfig',
            path: 'model_config.json',
            label: '模型配置',
            owner: 'core',
            state: 'ok',
            version: 2,
            supported: 2,
          },
        ])
      throw new Error(`unexpected ${operation}`)
    })
    const element = await mount()
    const notice = element.querySelector('[data-storage-readonly]')
    expect(notice?.textContent).toContain(
      '这个文件来自更新版本的 Emperor，当前版本只读',
    )
    expect(notice?.textContent).toContain('settings.json')
    expect(notice?.textContent).not.toContain('model_config.json')
  })

  it('shows no notice while every file is this version', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'storage.usage') return usage()
      if (operation === 'storage.versions') return versions()
      throw new Error(`unexpected ${operation}`)
    })
    const element = await mount()
    expect(element.querySelector('[data-storage-readonly]')).toBeNull()
    expect(
      element.querySelector('[data-group="storage-backup"]'),
    ).not.toBeNull()
  })

  it('opens 导出备份, and 从备份恢复 after main picked a backup', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'storage.usage') return usage()
      if (operation === 'storage.versions') return versions()
      throw new Error(`unexpected ${operation}`)
    })
    backup.planHomeBackup.mockReturnValue(new Promise(() => undefined))
    const element = await mount()
    element.querySelector<HTMLButtonElement>('[data-backup-export]')!.click()
    await settle()
    await vi.dynamicImportSettled()
    await settle()
    expect(
      document.querySelector('[data-testid="backup-export-dialog"]'),
    ).not.toBeNull()

    backup.openHomeBackup.mockResolvedValueOnce(null)
    element.querySelector<HTMLButtonElement>('[data-backup-restore]')!.click()
    await settle()
    expect(
      document.querySelector('[data-testid="backup-restore-dialog"]'),
    ).toBeNull()

    backup.openHomeBackup.mockResolvedValueOnce({
      id: 'r_0123456789ab',
      name: 'b.emperor-backup.zip',
      createdAt: '2026-10-20T10:00:00.000Z',
      appVersion: '0.2.0',
      categories: ['config'],
      credentials: false,
      files: 1,
      bytes: 100,
      newer: false,
    })
    element.querySelector<HTMLButtonElement>('[data-backup-restore]')!.click()
    await settle()
    await vi.dynamicImportSettled()
    await settle()
    expect(
      document.querySelector('[data-testid="backup-restore-dialog"]'),
    ).not.toBeNull()
  })

  it('says why a backup could not be opened', async () => {
    core.mockImplementation(async (operation: string) => {
      if (operation === 'storage.usage') return usage()
      if (operation === 'storage.versions') return versions()
      throw new Error(`unexpected ${operation}`)
    })
    backup.openHomeBackup.mockRejectedValueOnce(
      new Error('这个文件不是 Emperor 备份，或已经损坏。'),
    )
    const element = await mount()
    element.querySelector<HTMLButtonElement>('[data-backup-restore]')!.click()
    await settle()
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      '不是 Emperor 备份',
    )
  })
})
