// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolChatData } from '../../../conversation/types'
import ComputerUseView from './ComputerUseView.vue'

const { reveal, move, saveAs } = vi.hoisted(() => ({
  reveal: vi.fn(),
  move: vi.fn(),
  saveAs: vi.fn(),
}))
vi.mock('../../../api/backend', () => ({
  revealAgentDownload: reveal,
  moveAgentDownload: move,
  saveAgentDownloadAs: saveAs,
}))
vi.mock('./GenericToolCard.vue', () => ({ default: { render: () => null } }))

let app: App | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  reveal.mockReset()
  move.mockReset()
  saveAs.mockReset()
})

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await nextTick()
}

function download(state: string): ToolChatData {
  return {
    callId: 'call-1',
    name: 'browser_download',
    argsRaw: '{"ref":"r2.1"}',
    turn: 1,
    step: 1,
    time: 0,
    status: 'settled',
    approvals: [],
    result: {
      seq: 2,
      time: 1,
      content: [],
      isError: false,
      meta: {
        computerUse: {
          v: 1,
          tool: 'browser_download',
          outcome: 'observed',
          download: {
            downloadId: 'dl_0123456789ab',
            state,
            filename: 'report.csv',
            bytes: 1536,
          },
        },
      },
    },
  } as ToolChatData
}

function mount(data: ToolChatData): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(ComputerUseView, { data }) })
  app.mount(container)
  return container
}

describe('ComputerUseView downloads', () => {
  it('moves a completed download into the workspace on request', async () => {
    move.mockResolvedValue('/work/project/downloads/report.csv')
    const root = mount(download('completed'))
    const button = root.querySelector<HTMLButtonElement>(
      '[data-testid="computer-use-download-move"]',
    )!
    expect(move).not.toHaveBeenCalled()
    button.click()
    await settle()
    expect(move).toHaveBeenCalledWith('dl_0123456789ab')
    expect(root.textContent).toContain(
      '已移到 /work/project/downloads/report.csv',
    )
    expect(
      root.querySelector('[data-testid="computer-use-download-move"]'),
    ).toBeNull()
  })

  it('offers nothing to move for a refused download and shows move errors', async () => {
    const refused = mount(download('refused'))
    expect(
      refused.querySelector('[data-testid="computer-use-download-move"]'),
    ).toBeNull()
    app?.unmount()
    container?.remove()
    move.mockRejectedValue(new Error('找不到这个下载文件'))
    const root = mount(download('completed'))
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="computer-use-download-move"]',
      )!
      .click()
    await settle()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      '找不到这个下载文件',
    )
  })
})

describe('ComputerUseView notices', () => {
  function tool(name: string, text: string, meta?: object): ToolChatData {
    return {
      callId: 'call-2',
      name,
      argsRaw: '{}',
      turn: 1,
      step: 1,
      time: 0,
      status: 'settled',
      approvals: [],
      result: {
        seq: 2,
        time: 1,
        content: [{ type: 'text', text }],
        isError: true,
        ...(meta === undefined ? {} : { meta: { computerUse: meta } }),
      },
    } as ToolChatData
  }

  it('flags a credential refused for a look-alike page prominently', () => {
    const root = mount(
      tool(
        'browser_fill_credential',
        'computer-use PERMISSION_DENIED: credential binding mismatch (retryable: false; reason: credential-binding-mismatch; hint: -)',
      ),
    )
    expect(
      root.querySelector('[data-testid="computer-use-binding-mismatch"]')
        ?.textContent,
    ).toContain('可能是仿冒页面')
  })

  it('says typed text enters the task record, and saves a download elsewhere', async () => {
    const typed = mount(tool('browser_fill', '{"status":"ok"}'))
    expect(
      typed.querySelector('[data-testid="computer-use-records-text"]'),
    ).not.toBeNull()
    app?.unmount()
    container?.remove()
    saveAs.mockResolvedValue('/Users/me/Documents/report.csv')
    const root = mount(download('completed'))
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="computer-use-download-save-as"]',
      )!
      .click()
    await settle()
    expect(saveAs).toHaveBeenCalledWith('dl_0123456789ab')
    expect(root.textContent).toContain('已移到 /Users/me/Documents/report.csv')
  })
})
