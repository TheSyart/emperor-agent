import { afterEach, describe, expect, it, vi } from 'vitest'
import { core } from './http'

const g = globalThis as unknown as { window?: any }

afterEach(() => {
  delete g.window
  vi.restoreAllMocks()
})

describe('core IPC wrapper (W4: fake REST route table removed)', () => {
  it('invokes CoreApi operations directly by op name', async () => {
    const calls: unknown[][] = []
    g.window = {
      emperor: {
        invokeCore: async (...args: unknown[]) => {
          calls.push(args)
          return { totals: {} }
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(core('memory.tokens')).resolves.toEqual({ totals: {} })
    await expect(
      core('sessions.rename', 's1', { title: '新标题' }),
    ).resolves.toEqual({ totals: {} })

    expect(calls).toEqual([
      ['memory.tokens'],
      ['sessions.rename', 's1', { title: '新标题' }],
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails fast when the Core bridge is unavailable instead of falling back to HTTP', async () => {
    g.window = {}
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(core('memory.tokens')).rejects.toThrow(/IPC/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

function _assertCoreWrapperTypes(): void {
  void core('sessions.rename', 's1', { title: 'Typed' })

  // @ts-expect-error core() does not accept arbitrary operation strings
  void core('missing.operation')

  // @ts-expect-error sessions.rename requires both arguments
  void core('sessions.rename', 's1')
}
