import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelDictation,
  dictationStatus,
  onDictationEvent,
  startDictation,
  stopDictation,
} from './dictation'

const g = globalThis as unknown as { window?: unknown }

afterEach(() => {
  delete g.window
})

describe('dictation API', () => {
  it('is unavailable without the desktop bridge', async () => {
    expect(await dictationStatus()).toMatchObject({
      supported: false,
      available: false,
      permissions: { microphone: 'unknown', speech: 'unknown' },
    })
    expect(await startDictation()).toMatchObject({
      ok: false,
      code: 'unavailable',
    })
    expect(await stopDictation('session-0001')).toBe(false)
    expect(await cancelDictation('session-0001')).toBe(false)
    expect(typeof onDictationEvent(() => {})).toBe('function')
  })

  it('passes calls through, and turns bridge failures into answers', async () => {
    const dictationStart = vi.fn(async () => ({
      ok: true as const,
      session: 'session-0001',
    }))
    const dispose = vi.fn()
    g.window = {
      emperor: {
        dictationStatus: async () => {
          throw new Error('ipc down')
        },
        dictationStart,
        dictationStop: async () => ({ ok: true }),
        dictationCancel: async () => {
          throw new Error('ipc down')
        },
        onDictationEvent: () => dispose,
      },
    }
    expect(await startDictation({ locale: 'zh-CN' })).toEqual({
      ok: true,
      session: 'session-0001',
    })
    expect(dictationStart).toHaveBeenCalledWith({ locale: 'zh-CN' })
    expect(await stopDictation('session-0001')).toBe(true)
    expect(await cancelDictation('session-0001')).toBe(false)
    expect(await dictationStatus()).toMatchObject({
      supported: true,
      available: false,
    })
    onDictationEvent(() => {})()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
