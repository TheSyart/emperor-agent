import { describe, expect, it, vi } from 'vitest'
import { claimSingleInstance } from './single-instance'

function fakeApp(granted: boolean) {
  const listeners = new Map<string, () => void>()
  return {
    requestSingleInstanceLock: vi.fn(() => granted),
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
    }),
    emit: (event: string) => listeners.get(event)?.(),
  }
}

describe('single instance (MAIN-5)', () => {
  it('lets a second launch on the default data directory focus the first', () => {
    const app = fakeApp(true)
    const focus = vi.fn()
    expect(
      claimSingleInstance(
        app,
        { stateRootSource: 'default', packagedSmoke: false },
        focus,
      ),
    ).toBe(true)
    app.emit('second-instance')
    expect(focus).toHaveBeenCalledOnce()
  })

  it('tells the second launch to quit', () => {
    const app = fakeApp(false)
    expect(
      claimSingleInstance(
        app,
        { stateRootSource: 'default', packagedSmoke: false },
        vi.fn(),
      ),
    ).toBe(false)
  })

  it('leaves instances on other data directories alone (tests, packaged smoke)', () => {
    const app = fakeApp(false)
    expect(
      claimSingleInstance(
        app,
        { stateRootSource: 'env', packagedSmoke: false },
        vi.fn(),
      ),
    ).toBe(true)
    expect(
      claimSingleInstance(
        app,
        { stateRootSource: 'default', packagedSmoke: true },
        vi.fn(),
      ),
    ).toBe(true)
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled()
  })
})
