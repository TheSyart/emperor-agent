// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BackupRestoreDialog from './BackupRestoreDialog.vue'
import type { HomeBackupView } from '../../../api/homeBackup'

// 从备份恢复 (REL-03): what the backup replaces, that the current data is
// backed up first, the passphrase for the vault, then a restart.

const { api } = vi.hoisted(() => ({
  api: {
    restoreHomeBackup: vi.fn(),
    discardHomeBackup: vi.fn(),
  },
}))
vi.mock('../../../api/homeBackup', async (load) => ({
  ...(await load<typeof import('../../../api/homeBackup')>()),
  ...api,
}))

const VIEW: HomeBackupView = {
  id: 'r_0123456789ab',
  name: 'Emperor 备份 2026-10-20.emperor-backup.zip',
  createdAt: '2026-10-20T10:00:00.000Z',
  appVersion: '0.2.0',
  categories: ['config', 'memory', 'sessions'],
  credentials: true,
  files: 48,
  bytes: 3 * 1024 * 1024,
  newer: false,
}

let app: App | null = null
const open = ref(false)

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(view: HomeBackupView = VIEW): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  open.value = true
  app = createApp({
    render: () =>
      h(BackupRestoreDialog, {
        open: open.value,
        backup: view,
        'onUpdate:open': (value: boolean) => (open.value = value),
      }),
  })
  app.mount(container)
  await settle()
  return document.querySelector<HTMLElement>(
    '[data-testid="backup-restore-dialog"]',
  )!
}

function button(dialog: HTMLElement, action: string): HTMLButtonElement {
  return dialog.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
}

beforeEach(() => {
  api.restoreHomeBackup.mockReset()
  api.discardHomeBackup.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

describe('从备份恢复', () => {
  it('says what it replaces and that the current data is backed up first (8)', async () => {
    const dialog = await mount()
    const text = dialog.textContent ?? ''
    expect(text).toContain('Emperor 备份 2026-10-20.emperor-backup.zip')
    expect(text).toContain('Emperor 0.2.0')
    for (const title of ['设置与配置', '记忆', '会话'])
      expect(text).toContain(title)
    expect(text).toContain('先把当前数据移到')
    expect(text).toContain('重新启动')
    expect(button(dialog, 'restore').textContent).toContain('恢复并重新启动')
  })

  it('restores with the passphrase and says it is restarting', async () => {
    api.restoreHomeBackup.mockResolvedValue(undefined)
    const dialog = await mount()
    const field = dialog.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!
    field.value = 'backup passphrase 42'
    field.dispatchEvent(new Event('input'))
    await settle()
    button(dialog, 'restore').click()
    await settle()
    expect(api.restoreHomeBackup).toHaveBeenCalledWith(
      'r_0123456789ab',
      'backup passphrase 42',
    )
    expect(dialog.textContent).toContain('正在重新启动')
    expect(api.discardHomeBackup).not.toHaveBeenCalled()
  })

  it('shows a wrong passphrase and lets it be typed again', async () => {
    api.restoreHomeBackup.mockRejectedValueOnce(
      new Error('[credential-vault:backup-passphrase-wrong] wrong'),
    )
    const dialog = await mount()
    button(dialog, 'restore').click()
    await settle()
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      '备份口令不正确',
    )
    expect(button(dialog, 'restore').disabled).toBe(false)
  })

  it('throws the opened backup away when closed without restoring', async () => {
    const dialog = await mount({ ...VIEW, credentials: false })
    expect(dialog.querySelector('input[type="password"]')).toBeNull()
    button(dialog, 'cancel').click()
    await settle()
    expect(api.discardHomeBackup).toHaveBeenCalledWith('r_0123456789ab')
    expect(open.value).toBe(false)
  })

  it('warns about a backup from a newer Emperor', async () => {
    const dialog = await mount({ ...VIEW, appVersion: '0.9.0', newer: true })
    expect(dialog.textContent).toContain('来自更新版本的 Emperor')
  })
})
