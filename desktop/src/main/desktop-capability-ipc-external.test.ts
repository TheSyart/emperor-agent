// 下载历史记录 › Emperor 的下载 also lists what the Agent downloaded in the
// user's own Chrome or Edge (PLAN-CAP-001 RV-09): marked with the browser
// and its outcome, never a path, and without file actions.
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_DOWNLOADS_CHANNEL } from '../shared/ipc-contract'
import { registerDesktopCapabilityIpc } from './desktop-capability-ipc'

type Handler = (event: unknown, payload?: unknown) => unknown

class FakeIpcMain {
  private readonly handlers = new Map<string, Handler>()
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }
  on(): void {}
  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    return await this.handlers.get(channel)!({ sender: 'renderer' }, payload)
  }
}

describe('Emperor’s downloads from Chrome and Edge', () => {
  it('pass through with their browser and outcome', async () => {
    const ipc = new FakeIpcMain()
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize: vi.fn(),
      browser: {
        openUrl: vi.fn(),
        setBounds: vi.fn(),
        action: vi.fn(),
        close: vi.fn(),
        history: vi.fn(async () => []),
        openHistory: vi.fn(),
        clearData: vi.fn(),
      },
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(),
      userDownloads: {
        list: () => [],
        open: async () => '',
        reveal: () => false,
        remove: () => false,
        chooseFolder: async () => null,
      },
      agentDownloads: {
        reveal: vi.fn(() => false),
        list: () => [
          {
            downloadId: 'xd_0123456789ab',
            name: 'setup.dmg',
            origin: 'https://files.example',
            time: 9,
            bytes: 0,
            exists: false,
            browser: 'edge',
            state: 'refused',
            reason: 'executable',
          },
          {
            downloadId: 'xd_0123456789ac',
            name: 'odd.bin',
            origin: 'https://files.example',
            time: 8,
            bytes: 1,
            exists: false,
            browser: 'firefox',
            state: 'weird',
          },
        ],
      },
    } as unknown as Parameters<typeof registerDesktopCapabilityIpc>[0])
    const history = (await ipc.invoke(BROWSER_DOWNLOADS_CHANNEL)) as {
      agent: unknown[]
    }
    expect(history.agent).toEqual([
      {
        id: 'xd_0123456789ab',
        name: 'setup.dmg',
        site: 'https://files.example',
        sessionId: null,
        time: 9,
        bytes: 0,
        exists: false,
        browser: 'edge',
        state: 'refused',
        reason: 'executable',
      },
      // Unknown values never reach the page.
      {
        id: 'xd_0123456789ac',
        name: 'odd.bin',
        site: 'https://files.example',
        sessionId: null,
        time: 8,
        bytes: 1,
        exists: false,
      },
    ])
  })
})
