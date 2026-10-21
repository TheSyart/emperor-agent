// REL-05: the main preload names no version of its own; the renderer asks
// main, which answers app.getVersion().
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { APP_VERSION_CHANNEL } from '../shared/ipc-contract'

const exposed = new Map<string, Record<string, unknown>>()
const invoke = vi.fn(async (_channel: string) => '0.2.0')

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
      exposed.set(name, api)
    },
  },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}))

beforeAll(async () => {
  await import('./index')
})

describe('main preload bridge: the app version (REL-05 test 5)', () => {
  it('asks main for the version instead of carrying one', async () => {
    const api = exposed.get('emperor')
    expect(api).toBeDefined()
    expect(api).not.toHaveProperty('version')
    expect(api!.appVersion).toBeTypeOf('function')

    const version = await (api!.appVersion as () => Promise<string>)()

    expect(version).toBe('0.2.0')
    expect(invoke).toHaveBeenCalledWith(APP_VERSION_CHANNEL)
  })

  it('has no version number written into its source', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    expect(source).not.toMatch(/\bversion:\s*['"`]/)
    expect(source).not.toMatch(/['"`]\d+\.\d+\.\d+/)
  })
})
