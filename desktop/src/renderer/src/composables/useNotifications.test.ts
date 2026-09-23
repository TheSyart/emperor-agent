import { afterEach, describe, expect, it, vi } from 'vitest'

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

async function load() {
  vi.resetModules()
  return await import('./useNotifications')
}

const sample = {
  key: 'turn:s2:48',
  kind: 'turn' as const,
  tone: 'success' as const,
  title: '后台会话',
  detail: '回合已完成',
  target: { type: 'session' as const, sessionId: 's2' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useNotifications', () => {
  it('restores the stored list and persists every change', async () => {
    const storage = memoryStorage({
      'emperor.notifications.v1': JSON.stringify({
        items: [{ ...sample, key: 'old', createdAt: 1, read: false }],
      }),
    })
    vi.stubGlobal('localStorage', storage)
    const { useNotifications, NOTIFICATIONS_STORAGE_KEY } = await load()
    const notifications = useNotifications()
    expect(notifications.items.value.map((item) => item.key)).toEqual(['old'])
    expect(notifications.unreadCount.value).toBe(1)

    notifications.add(sample)
    expect(notifications.unreadCount.value).toBe(2)
    const stored = JSON.parse(storage.data.get(NOTIFICATIONS_STORAGE_KEY)!)
    expect(stored.items.map((item: { key: string }) => item.key)).toEqual([
      'turn:s2:48',
      'old',
    ])

    notifications.markSessionRead('s2')
    expect(notifications.unreadCount.value).toBe(0)
    notifications.clear()
    expect(storage.data.has(NOTIFICATIONS_STORAGE_KEY)).toBe(false)
  })

  it('keeps working in memory when storage throws or holds junk', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    const { useNotifications } = await load()
    const notifications = useNotifications()
    expect(notifications.items.value).toEqual([])
    notifications.add(sample)
    expect(notifications.unreadCount.value).toBe(1)
    notifications.markAllRead()
    expect(notifications.unreadCount.value).toBe(0)
  })
})
