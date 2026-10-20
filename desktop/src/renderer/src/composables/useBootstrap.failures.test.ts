// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => vi.fn())
vi.mock('../api/http', () => ({ core }))

import { useBootstrap } from './useBootstrap'

const payload = (sessionId: string | null) => ({
  app: 'Emperor Agent',
  runtime: { sessionId, events: [], latestSeq: 0 },
})

beforeEach(() => {
  core.mockReset()
})

describe('useBootstrap: startup failure apart from refresh failures (FIX-03)', () => {
  it('3 · a failed first start shows the full-screen error', async () => {
    core.mockRejectedValue(new Error('core down'))
    const toast = vi.fn()
    const b = useBootstrap(toast)
    expect(await b.loadBootstrap(true, '')).toBe(false)
    expect(b.error.value).toBe('core down')
    expect(b.boot.value).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it('2 · a failed refresh after start keeps the shell and only toasts', async () => {
    core.mockResolvedValueOnce(payload('s1'))
    const toast = vi.fn()
    const b = useBootstrap(toast)
    await b.loadBootstrap(true, '')
    core.mockResolvedValueOnce(undefined) // config.save
    core.mockRejectedValue(new Error('refresh failed'))
    await b.saveConfig('name: me').catch(() => undefined)
    expect(b.error.value).toBe('')
    expect(b.boot.value).not.toBeNull()
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('refresh failed'),
    )
  })

  it('1 · a session gone elsewhere falls back to a plain bootstrap and reports it', async () => {
    core.mockResolvedValueOnce(payload('s1'))
    const unavailable = vi.fn()
    const b = useBootstrap(vi.fn(), { onSessionUnavailable: unavailable })
    await b.loadBootstrap(true, 's1')
    core.mockRejectedValueOnce(new Error('session archived'))
    core.mockResolvedValueOnce(payload(null))
    expect(await b.loadBootstrap(false, 'gone')).toBe(true)
    expect(core).toHaveBeenLastCalledWith('bootstrap', { sessionId: null })
    expect(unavailable).toHaveBeenCalledWith('gone')
    expect(b.error.value).toBe('')
  })

  it('10 · 重新连接 bootstraps without a session id', async () => {
    core.mockRejectedValue(new Error('core down'))
    const b = useBootstrap(vi.fn())
    await b.loadBootstrap(true, 's1')
    expect(b.error.value).toBe('core down')
    core.mockResolvedValueOnce(payload(null))
    expect(await b.retry()).toBe(true)
    expect(core).toHaveBeenLastCalledWith('bootstrap', { sessionId: null })
    expect(b.error.value).toBe('')
    expect(b.boot.value).not.toBeNull()
  })
})
