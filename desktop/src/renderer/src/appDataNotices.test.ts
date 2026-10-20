import { describe, expect, it, vi } from 'vitest'
import { showDataNotices } from './appDataNotices'

// REL-03 at startup: running an older Emperor than last time shows a
// banner (a sticky notice with 「查看」 → 设置 › 高级 › 存储), card test 3;
// the first start after a restore says so once.

function report(overrides: Record<string, unknown> = {}) {
  return {
    appVersion: '0.2.0',
    lastRunVersion: '0.2.0',
    previousRunVersion: '0.3.0',
    downgradedFrom: '0.3.0',
    dataVersion: 1,
    supportedDataVersion: 1,
    files: [
      {
        id: 'settings',
        path: 'settings.json',
        label: '设置',
        owner: 'core',
        state: 'newer',
        version: 2,
        supported: 1,
      },
    ],
    lastRestore: null,
    ...overrides,
  }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

describe('showDataNotices', () => {
  it('shows the downgrade banner with both versions and 查看 (3)', async () => {
    const toast = vi.fn(() => 1)
    const openStorage = vi.fn()
    await showDataNotices({
      load: async () => report() as never,
      toast,
      openStorage,
      storage: memoryStorage(),
    })
    expect(toast).toHaveBeenCalledTimes(1)
    const [message, options] = toast.mock.calls[0] as unknown as [
      string,
      {
        tone: string
        sticky: boolean
        action: { label: string; run: () => void }
      },
    ]
    expect(message).toContain('0.2.0')
    expect(message).toContain('0.3.0')
    expect(message).toContain('只读')
    expect(options).toMatchObject({ tone: 'warn', sticky: true })
    expect(options.action.label).toBe('查看')
    options.action.run()
    expect(openStorage).toHaveBeenCalled()
  })

  it('stays quiet on a normal start and when the report fails', async () => {
    const toast = vi.fn(() => 1)
    await showDataNotices({
      load: async () =>
        report({
          downgradedFrom: null,
          previousRunVersion: '0.1.0',
          files: [],
        }) as never,
      toast,
      openStorage: vi.fn(),
      storage: memoryStorage(),
    })
    await showDataNotices({
      load: async () => {
        throw new Error('Core is not ready')
      },
      toast,
      openStorage: vi.fn(),
      storage: memoryStorage(),
    })
    expect(toast).not.toHaveBeenCalled()
  })

  it('says a restore finished, once', async () => {
    const toast = vi.fn(() => 1)
    const storage = memoryStorage()
    const restored = report({
      downgradedFrom: null,
      files: [],
      lastRestore: {
        at: '2026-10-20T10:05:00.000Z',
        status: 'applied',
        backup: 'migrations/backup-2026-10-20T10-05-00-000Z',
        backupCreatedAt: '2026-10-19T08:00:00.000Z',
      },
    })
    const deps = {
      load: async () => restored as never,
      toast,
      openStorage: vi.fn(),
      storage,
      now: () => Date.parse('2026-10-20T10:05:40.000Z'),
    }
    await showDataNotices(deps)
    await showDataNotices(deps)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(String((toast.mock.calls[0] as unknown[])[0])).toContain(
      '已从备份恢复',
    )
  })
})
