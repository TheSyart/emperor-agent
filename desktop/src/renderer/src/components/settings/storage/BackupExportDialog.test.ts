// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BackupExportDialog from './BackupExportDialog.vue'

// 导出备份 (REL-03): what the backup holds, 包含会话, the vault only under a
// passphrase, then main's save dialog; the result names the file.

const { api } = vi.hoisted(() => ({
  api: {
    planHomeBackup: vi.fn(),
    exportHomeBackup: vi.fn(),
    revealHomeBackup: vi.fn(),
  },
}))
vi.mock('../../../api/homeBackup', async (load) => ({
  ...(await load<typeof import('../../../api/homeBackup')>()),
  ...api,
}))

const MB = 1024 * 1024

function plan(vault: { state: string; entries: number }) {
  return {
    name: 'Emperor 备份 2026-10-20',
    categories: [
      {
        id: 'config',
        title: '设置与配置',
        description: '',
        files: 5,
        bytes: 0.1 * MB,
        optional: false,
      },
      {
        id: 'memory',
        title: '记忆',
        description: '',
        files: 3,
        bytes: 0.2 * MB,
        optional: false,
      },
      {
        id: 'extensions',
        title: 'Skills、插件与智能体',
        description: '',
        files: 9,
        bytes: 4 * MB,
        optional: false,
      },
      {
        id: 'projects',
        title: '项目与定时任务',
        description: '',
        files: 2,
        bytes: 0.01 * MB,
        optional: false,
      },
      {
        id: 'sessions',
        title: '会话',
        description: '',
        files: 40,
        bytes: 120 * MB,
        optional: true,
      },
    ],
    excluded: ['浏览器登录资料与缓存', '日志'],
    vault,
  }
}

let app: App | null = null
const open = ref(false)

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  open.value = true
  app = createApp({
    render: () =>
      h(BackupExportDialog, {
        open: open.value,
        'onUpdate:open': (value: boolean) => (open.value = value),
      }),
  })
  app.mount(container)
  await settle()
  return document.querySelector<HTMLElement>(
    '[data-testid="backup-export-dialog"]',
  )!
}

function button(dialog: HTMLElement, action: string): HTMLButtonElement {
  return dialog.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
}

function check(dialog: HTMLElement, name: string): HTMLInputElement {
  return dialog.querySelector<HTMLInputElement>(
    `[data-option="${name}"] input`,
  )!
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  api.planHomeBackup.mockReset()
  api.exportHomeBackup.mockReset()
  api.revealHomeBackup.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

describe('导出备份', () => {
  it('lists what the backup holds and exports with the sessions', async () => {
    api.planHomeBackup.mockResolvedValue(plan({ state: 'empty', entries: 0 }))
    api.exportHomeBackup.mockResolvedValue({
      ok: true,
      name: 'Emperor 备份 2026-10-20.emperor-backup.zip',
      location: '~/Documents',
      credentials: false,
    })
    const dialog = await mount()
    const text = dialog.textContent ?? ''
    for (const title of ['设置与配置', '记忆', '会话', '120 MB'])
      expect(text).toContain(title)
    expect(text).toContain('浏览器登录资料与缓存')
    expect(check(dialog, 'sessions').checked).toBe(true)
    // An empty vault has nothing to protect: the option stays off.
    expect(check(dialog, 'credentials').disabled).toBe(true)

    button(dialog, 'export').click()
    await settle()
    expect(api.exportHomeBackup).toHaveBeenCalledWith({ includeSessions: true })
    expect(dialog.textContent).toContain(
      'Emperor 备份 2026-10-20.emperor-backup.zip',
    )
    expect(dialog.textContent).toContain('~/Documents')
    button(dialog, 'reveal').click()
    expect(api.revealHomeBackup).toHaveBeenCalled()
  })

  it('takes the vault only with a passphrase typed twice (7)', async () => {
    api.planHomeBackup.mockResolvedValue(plan({ state: 'ready', entries: 3 }))
    api.exportHomeBackup.mockResolvedValue({
      ok: true,
      name: 'b.emperor-backup.zip',
      location: '~/Desktop',
      credentials: true,
    })
    const dialog = await mount()
    check(dialog, 'sessions').click()
    check(dialog, 'credentials').click()
    await settle()
    const fields = dialog.querySelectorAll<HTMLInputElement>(
      'input[type="password"]',
    )
    expect(fields).toHaveLength(2)
    type(fields[0]!, 'twelve characters')
    type(fields[1]!, 'twelve characterz')
    await settle()
    button(dialog, 'export').click()
    await settle()
    expect(api.exportHomeBackup).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain('两次输入的口令不一致')

    type(fields[1]!, 'twelve characters')
    await settle()
    button(dialog, 'export').click()
    await settle()
    expect(api.exportHomeBackup).toHaveBeenCalledWith({
      includeSessions: false,
      passphrase: 'twelve characters',
      confirmation: 'twelve characters',
    })
    expect(dialog.textContent).toContain('密码管理器已用口令加密')
  })

  it('says a locked vault must be unlocked first', async () => {
    api.planHomeBackup.mockResolvedValue(plan({ state: 'locked', entries: 2 }))
    const dialog = await mount()
    expect(check(dialog, 'credentials').disabled).toBe(true)
    expect(dialog.textContent).toContain('先在 设置 › 浏览器 › 密码管理器 解锁')
  })

  it('keeps the dialog open when the save dialog is cancelled', async () => {
    api.planHomeBackup.mockResolvedValue(plan({ state: 'empty', entries: 0 }))
    api.exportHomeBackup.mockResolvedValue({ ok: false, canceled: true })
    const dialog = await mount()
    button(dialog, 'export').click()
    await settle()
    expect(button(dialog, 'export')).not.toBeNull()
    expect(dialog.querySelector('[role="alert"]')).toBeNull()
  })
})
