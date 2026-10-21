// @vitest-environment jsdom
// REL-02: 设置 › 常规 › 更新 and the prompt at the top of the page — the
// switch, 立即检查, 「Emperor 0.2.1 可用 · 查看更新说明 · 下载」, the
// download's progress, a verified DMG with its install steps, and a
// refused one.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@emperor/core/runtime-contract'
import UpdateGroup from './UpdateGroup.vue'
import UpdateNotice from './UpdateNotice.vue'
import { resetUpdateStatusForTest } from './useUpdateStatus'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../../api/http', () => ({ core }))
const backend = vi.hoisted(() => ({
  listeners: [] as Array<(event: unknown) => void>,
  openLink: vi.fn(async () => 'system'),
}))
vi.mock('../../../api/backend', () => ({
  onCoreEvent: (listener: (event: unknown) => void) => {
    backend.listeners.push(listener)
    return () => {}
  },
  openLink: backend.openLink,
}))

function updateStatus(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    supported: true,
    automatic: true,
    disabledReason: null,
    enabled: true,
    currentVersion: '0.2.0',
    channel: 'stable',
    checking: false,
    lastCheckedAt: null,
    lastError: null,
    available: null,
    download: { phase: 'idle' },
    electron: {
      current: '42.2.0',
      latest: null,
      behind: null,
      outdated: false,
    },
    feedOverride: null,
    ...patch,
  }
}

const RELEASE = {
  version: '0.2.1',
  tag: 'v0.2.1',
  channel: 'stable' as const,
  name: 'Emperor Agent v0.2.1',
  publishedAt: '2026-10-21T08:00:00Z',
  notesUrl: 'https://github.com/TheSyart/emperor-agent/releases/tag/v0.2.1',
  asset: {
    name: 'Emperor-Agent-0.2.1-macos-arm64.dmg',
    size: 200 * 1024 * 1024,
  },
}

let app: App | null = null
let root: HTMLDivElement

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await nextTick()
}

async function mount(status: UpdateStatus): Promise<HTMLDivElement> {
  core.mockImplementation(async (operation: string, ...args: unknown[]) => {
    if (operation === 'updates.status') return status
    if (operation === 'updates.setEnabled')
      return { ...status, enabled: args[0] as boolean }
    if (operation === 'updates.download')
      return {
        ...status,
        download: {
          phase: 'downloading',
          version: '0.2.1',
          fileName: RELEASE.asset.name,
          receivedBytes: 0,
          totalBytes: RELEASE.asset.size,
        },
      }
    return status
  })
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => [h(UpdateNotice), h(UpdateGroup)] })
  app.mount(root)
  await settle()
  return root
}

function push(status: UpdateStatus): Promise<void> {
  for (const listener of backend.listeners)
    listener({ event: 'update_status', status, seq: 0 })
  return settle()
}

function button(text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

beforeEach(() => {
  resetUpdateStatusForTest()
  backend.listeners.length = 0
  core.mockReset()
  backend.openLink.mockClear()
})

afterEach(() => {
  app?.unmount()
  app = null
  root?.remove()
})

describe('设置 › 常规 › 更新 (REL-02)', () => {
  it('1 · a newer version: 「Emperor 0.2.1 可用」 with 查看更新说明 and 下载', async () => {
    await mount(updateStatus({ available: RELEASE, lastCheckedAt: 1 }))
    const notice = root.querySelector('[data-update-state="available"]')!
    expect(notice.textContent).toContain('Emperor 0.2.1 可用')
    button('查看更新说明').click()
    await settle()
    expect(backend.openLink).toHaveBeenCalledWith(RELEASE.notesUrl)
    button('下载').click()
    await settle()
    expect(core).toHaveBeenCalledWith('updates.download')
    expect(
      root.querySelector('[data-update-state="downloading"]')?.textContent,
    ).toContain('正在下载 Emperor 0.2.1')
    expect(root.querySelector('[data-update-line]')?.textContent).toContain(
      'Emperor 0.2.1 可用',
    )
  })

  it('2 · up to date: no prompt, just the version line', async () => {
    await mount(updateStatus({ lastCheckedAt: Date.now() }))
    expect(root.querySelector('[data-update-notice]')).toBeNull()
    expect(root.querySelector('[data-update-line]')?.textContent).toContain(
      '当前版本 0.2.0',
    )
    expect(root.querySelector('[data-update-line]')?.textContent).toContain(
      '已是最新版本',
    )
    button('立即检查').click()
    await settle()
    expect(core).toHaveBeenCalledWith('updates.check')
  })

  it('6 · the switch turns checking off; off, there is nothing to check by hand', async () => {
    await mount(updateStatus())
    const toggle = root.querySelector<HTMLElement>('#general-update-check')!
    toggle.click()
    await settle()
    expect(core).toHaveBeenCalledWith('updates.setEnabled', false)
    expect(root.querySelector('[data-update-check]')).toBeNull()
    expect(root.querySelector('[data-update-line]')?.textContent).toContain(
      '已关闭',
    )
  })

  it('follows progress, then shows a verified DMG with the install steps', async () => {
    await mount(updateStatus({ available: RELEASE }))
    await push(
      updateStatus({
        available: RELEASE,
        download: {
          phase: 'downloading',
          version: '0.2.1',
          fileName: RELEASE.asset.name,
          receivedBytes: 50 * 1024 * 1024,
          totalBytes: RELEASE.asset.size,
        },
      }),
    )
    const bar = root.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(root.textContent).toContain('已下载 50 MB / 200 MB')
    button('取消')

    await push(
      updateStatus({
        available: RELEASE,
        download: {
          phase: 'ready',
          version: '0.2.1',
          fileName: RELEASE.asset.name,
          path: '/Users/me/Downloads/Emperor-Agent-0.2.1-macos-arm64.dmg',
          attestation: { status: 'unavailable', reason: 'gh_missing' },
        },
      }),
    )
    const ready = root.querySelector('[data-update-state="ready"]')!
    expect(ready.textContent).toContain('Emperor 0.2.1 已下载并通过校验')
    // 5 · SHA-256 only, and the UI says why.
    expect(ready.textContent).toContain('没有可用的 GitHub CLI（gh）')
    expect(ready.querySelectorAll('ol li')).toHaveLength(3)
    expect(ready.textContent).toContain('「系统设置 › 隐私与安全性」')
    button('在访达中显示').click()
    await settle()
    expect(core).toHaveBeenCalledWith('updates.reveal')
  })

  it('4 · a refused download says the file was deleted and offers 重新下载', async () => {
    await mount(
      updateStatus({
        available: RELEASE,
        download: {
          phase: 'failed',
          version: '0.2.1',
          fileName: RELEASE.asset.name,
          code: 'update_checksum_mismatch',
          message:
            '安装包的 SHA-256 与 SHA256SUMS.txt 不符，已拒绝并删除下载的文件。',
        },
      }),
    )
    const failed = root.querySelector('[data-update-state="failed"]')!
    expect(failed.textContent).toContain('Emperor 0.2.1 没有下载成功')
    expect(failed.textContent).toContain('已拒绝并删除下载的文件')
    button('重新下载')
  })

  it('a test feed in effect is said plainly', async () => {
    await mount(
      updateStatus({ feedOverride: 'http://127.0.0.1:8765/releases' }),
    )
    const notice = root.querySelector('[data-update-test-feed]')!
    expect(notice.textContent).toContain('正在使用测试更新源')
    expect(notice.textContent).toContain('http://127.0.0.1:8765/releases')
  })

  it('a development build cannot be switched on', async () => {
    await mount(
      updateStatus({ automatic: false, disabledReason: 'development' }),
    )
    expect(
      root
        .querySelector('#general-update-check')
        ?.getAttribute('aria-disabled') === 'true' ||
        root.querySelector<HTMLButtonElement>('#general-update-check')
          ?.disabled,
    ).toBe(true)
    expect(root.textContent).toContain('开发版不检查更新')
  })
})
