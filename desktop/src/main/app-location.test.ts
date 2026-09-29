import { describe, expect, it, vi } from 'vitest'
import {
  isTranslocated,
  offerMoveToApplications,
  type AppLocationDeps,
} from './app-location'

const TRANSLOCATED =
  '/private/var/folders/xy/T/AppTranslocation/6D1C/d/Emperor Agent.app/Contents/MacOS/Emperor Agent'

function deps(overrides: Partial<AppLocationDeps> = {}) {
  const ask = vi.fn(async () => 0)
  const moveToApplications = vi.fn(() => true)
  return {
    ask,
    moveToApplications,
    all: {
      platform: 'darwin' as const,
      isPackaged: true,
      executablePath: TRANSLOCATED,
      ask,
      moveToApplications,
      ...overrides,
    },
  }
}

describe('app location', () => {
  it('recognizes an App Translocation path', () => {
    expect(isTranslocated(TRANSLOCATED)).toBe(true)
    expect(
      isTranslocated(
        '/Applications/Emperor Agent.app/Contents/MacOS/Emperor Agent',
      ),
    ).toBe(false)
  })

  it('offers the move for a translocated packaged app and moves on consent', async () => {
    const { all, ask, moveToApplications } = deps()
    await expect(offerMoveToApplications(all)).resolves.toBe(true)
    expect(ask).toHaveBeenCalledOnce()
    expect(moveToApplications).toHaveBeenCalledOnce()
  })

  it('keeps starting when the user postpones or the move fails', async () => {
    const later = deps({ ask: vi.fn(async () => 1) })
    await expect(offerMoveToApplications(later.all)).resolves.toBe(false)
    expect(later.moveToApplications).not.toHaveBeenCalled()

    const failing = deps({
      moveToApplications: vi.fn(() => {
        throw new Error('cancelled')
      }),
    })
    await expect(offerMoveToApplications(failing.all)).resolves.toBe(false)
  })

  it('asks nothing elsewhere: other paths, development runs or other systems', async () => {
    for (const overrides of [
      { executablePath: '/Applications/Emperor Agent.app/Contents/MacOS/x' },
      { isPackaged: false },
      { platform: 'win32' as const },
    ]) {
      const { all, ask } = deps(overrides)
      await expect(offerMoveToApplications(all)).resolves.toBe(false)
      expect(ask).not.toHaveBeenCalled()
    }
  })
})
