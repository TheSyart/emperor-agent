// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StorageSection from './StorageSection.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'

// 设置 › 高级 › 存储 (KRN-12): what Emperor Home holds by category, and
// 「清理」 (after a confirm) saying what it freed.

const { core, confirm } = vi.hoisted(() => ({
  core: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('../../api/http', () => ({ core }))
vi.mock('../ui/confirm', () => ({ confirm }))

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
})

afterEach(() => {
  app?.unmount()
  app = null
  root?.remove()
  root = null
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
