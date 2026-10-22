// REL-05: the renderer reads the version of the running app from main
// (app.getVersion()), never from a string written into the preload.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { APP_VERSION_CHANNEL } from '../shared/ipc-contract'
import { registerAppVersionIpc } from './app-version-ipc'

const desktopRoot = resolve(__dirname, '..', '..')
const repoRoot = resolve(desktopRoot, '..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function register(authorize: (event: unknown) => void = () => undefined) {
  const handlers = new Map<string, (event: unknown) => unknown>()
  const version = vi.fn(() => '0.2.0')
  registerAppVersionIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
    },
    authorize,
    version,
  })
  return { handler: handlers.get(APP_VERSION_CHANNEL), version }
}

describe('the app version over IPC (REL-05 test 5)', () => {
  it('answers what app.getVersion() says to the trusted main window', async () => {
    const authorize = vi.fn()
    const { handler, version } = register(authorize)
    const event = { sender: { id: 1 } }

    expect(handler).toBeTypeOf('function')
    expect(await handler!(event)).toBe('0.2.0')
    expect(authorize).toHaveBeenCalledWith(event)
    expect(version).toHaveBeenCalledOnce()
  })

  it('reads nothing for a sender the policy refuses', async () => {
    const { handler, version } = register(() => {
      throw new Error('untrusted renderer')
    })

    await expect(async () => handler!({ sender: { id: 9 } })).rejects.toThrow(
      'untrusted renderer',
    )
    expect(version).not.toHaveBeenCalled()
  })

  it('ships 0.2.0: desktop, Core and both lockfiles agree', () => {
    const desktop = readJson(resolve(desktopRoot, 'package.json'))
    const core = readJson(resolve(repoRoot, 'packages', 'core', 'package.json'))
    const desktopLock = readJson(resolve(desktopRoot, 'package-lock.json')) as {
      version?: string
      packages?: Record<string, { version?: string }>
    }
    const rootLock = readJson(resolve(repoRoot, 'package-lock.json')) as {
      packages?: Record<string, { version?: string }>
    }

    expect(desktop.version).toBe('0.2.0')
    expect(core.version).toBe('0.2.0')
    expect(desktopLock.version).toBe('0.2.0')
    expect(desktopLock.packages?.['']?.version).toBe('0.2.0')
    expect(desktopLock.packages?.['../packages/core']?.version).toBe('0.2.0')
    expect(rootLock.packages?.['packages/core']?.version).toBe('0.2.0')
  })
})
