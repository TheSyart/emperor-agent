// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultEntry, VaultStatus } from '../../../api/backend'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from '../settingsHeader'
import PasswordManagerPage from './PasswordManagerPage.vue'

const api = vi.hoisted(() => ({
  vaultStatus: vi.fn(),
  vaultSave: vi.fn(),
  vaultRemove: vi.fn(),
  vaultUnlock: vi.fn(),
  vaultLock: vi.fn(),
  vaultMaster: vi.fn(),
  vaultReveal: vi.fn(),
  vaultReset: vi.fn(),
  vaultRepairKey: vi.fn(),
  vaultStartOver: vi.fn(),
  vaultExport: vi.fn(),
  vaultImportPick: vi.fn(),
  vaultImport: vi.fn(),
}))
vi.mock('../../../api/backend', () => api)

let app: App | null = null
let container: HTMLDivElement | null = null
let host: SettingsHeaderHost

const site: VaultEntry = {
  handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa',
  label: 'Site',
  bindings: [{ kind: 'origin', origin: 'https://site.test' }],
  fields: ['password'],
  fillMode: 'confirm',
  revealUsername: true,
}

function status(patch: Partial<VaultStatus> = {}): VaultStatus {
  return {
    available: true,
    backend: 'emperor-local',
    locked: false,
    hasMasterPassword: false,
    handles: [site],
    ...patch,
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

function render(root: HTMLElement): void {
  host = createSettingsHeader()
  app = createApp({ render: () => h(PasswordManagerPage) })
  app.provide(SETTINGS_HEADER_KEY, host)
  app.mount(root)
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  render(container)
  await settle()
  return container
}

/** The header's 添加, when the vault takes new entries. */
function addAction() {
  return host.actions.value.find((action) => action.id === 'add-credential')
}

async function openAdd(): Promise<void> {
  addAction()!.onClick!()
  await settle()
}

/** Submit the master password dialog. */
async function submitProtect(): Promise<void> {
  document.body
    .querySelector('form.vault-protect')!
    .dispatchEvent(new Event('submit', { cancelable: true }))
  await settle()
}

function dialogInput(label: string): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>(
    `form.vault-protect input[aria-label="${label}"]`,
  )
  if (!input) throw new Error(`no dialog input ${label}`)
  return input
}

/** The entry form (in its dialog). */
function form(): HTMLFormElement | null {
  return document.body.querySelector<HTMLFormElement>('form.vault-form')
}

function button(root: HTMLElement, text: string, index = 0): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].filter((item) =>
    item.textContent?.includes(text),
  )[index]
  if (!found) throw new Error(`no button ${text}`)
  return found
}

function checkbox(_root: HTMLElement, label: string): HTMLInputElement {
  const found = [...document.body.querySelectorAll('label.vault-check')].find(
    (item) => item.textContent?.includes(label),
  )
  const input = found?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error(`no checkbox ${label}`)
  return input
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await settle()
}

async function tick(input: HTMLInputElement): Promise<void> {
  input.checked = !input.checked
  input.dispatchEvent(new Event('change'))
  await settle()
}

function field(_root: HTMLElement, label: string): HTMLInputElement {
  const found = [...document.body.querySelectorAll('.vault-form label')].find(
    (item) => item.textContent?.includes(label),
  )
  const input = found?.querySelector('input')
  if (!input) throw new Error(`no field ${label}`)
  return input
}

async function submit(_root: HTMLElement): Promise<void> {
  form()!.dispatchEvent(new Event('submit', { cancelable: true }))
  await settle()
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  document.body.innerHTML = ''
  for (const mock of Object.values(api)) mock.mockReset()
})

describe('credential vault settings', () => {
  it('keeps the entry’s username visibility when it has no username', async () => {
    api.vaultStatus.mockResolvedValue(status())
    api.vaultSave.mockResolvedValue(site)
    const root = await mount()
    button(root, '编辑').click()
    await settle()
    expect(field(root, '允许 Agent').checked).toBe(true)
    await submit(root)
    expect(api.vaultSave).toHaveBeenCalledTimes(1)
    const draft = api.vaultSave.mock.calls[0]![0] as Record<string, unknown>
    expect(draft).toMatchObject({
      handleId: site.handleId,
      revealUsername: true,
      bindings: site.bindings,
    })
    expect(draft).not.toHaveProperty('username')
    expect(draft).not.toHaveProperty('password')
  })

  it('keeps a hidden username on a blank edit and clears a shown one', async () => {
    const hidden: VaultEntry = {
      ...site,
      handleId: 'cred_bbbbbbbbbbbbbbbbbbbbbbbb',
      label: 'Hidden',
      fields: ['username', 'password'],
      revealUsername: false,
    }
    const shown: VaultEntry = {
      ...site,
      handleId: 'cred_cccccccccccccccccccccccc',
      label: 'Shown',
      fields: ['username', 'password'],
      username: 'alice',
    }
    api.vaultStatus.mockResolvedValue(status({ handles: [hidden, shown] }))
    api.vaultSave.mockResolvedValue(hidden)
    const root = await mount()
    button(root, '编辑', 0).click()
    await settle()
    expect(field(root, '用户名').placeholder).toContain('已保存但不显示')
    expect(field(root, '允许 Agent').checked).toBe(false)
    await submit(root)
    const first = api.vaultSave.mock.calls[0]![0] as Record<string, unknown>
    expect(first).not.toHaveProperty('username')
    expect(first.revealUsername).toBe(false)

    button(root, '编辑', 1).click()
    await settle()
    const username = field(root, '用户名')
    expect(username.value).toBe('alice')
    username.value = ''
    username.dispatchEvent(new Event('input'))
    await submit(root)
    const second = api.vaultSave.mock.calls[1]![0] as Record<string, unknown>
    expect(second).toMatchObject({ handleId: shown.handleId, username: '' })
  })

  it('offers 清空 when the local key is lost, and only after confirming', async () => {
    api.vaultStatus.mockResolvedValue(
      status({ available: false, problem: 'key-missing' }),
    )
    api.vaultReset.mockResolvedValue(undefined)
    const root = await mount()
    const notice = root.querySelector('.ds-settings-notice')
    expect(notice?.getAttribute('data-tone')).toBe('error')
    expect(notice?.textContent).toContain('已保存的密码无法解密')
    expect(notice?.textContent).toContain('本地密钥')
    expect(root.textContent).toContain('无法解密')
    // Nothing can be added or changed until it is cleared.
    expect(addAction()).toBeUndefined()
    expect(button(root, '编辑').disabled).toBe(true)
    expect(button(root, '查看密码').disabled).toBe(true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    button(notice as HTMLElement, '清空').click()
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(api.vaultReset).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    api.vaultStatus.mockResolvedValue(status({ handles: [] }))
    button(notice as HTMLElement, '清空').click()
    await settle()
    expect(api.vaultReset).toHaveBeenCalledTimes(1)
    expect(root.querySelector('.ds-settings-notice')).toBeNull()
    expect(addAction()).toBeDefined()
    confirm.mockRestore()
  })

  it('names a key file that fails its checks', async () => {
    api.vaultStatus.mockResolvedValue(
      status({ available: false, problem: 'key-invalid', handles: [] }),
    )
    const root = await mount()
    const notice = root.querySelector('.ds-settings-notice')
    expect(notice?.textContent).toContain('属主或内容不对')
    expect(button(notice as HTMLElement, '清空')).toBeTruthy()
  })

  it('shows protection strength and each entry’s last fill', async () => {
    const used: VaultEntry = {
      ...site,
      handleId: 'cred_dddddddddddddddddddddddd',
      label: 'Used',
      lastUsedAt: Date.UTC(2026, 8, 25, 6, 30),
    }
    api.vaultStatus.mockResolvedValue(status({ handles: [site, used] }))
    const root = await mount()
    expect(root.textContent).toContain(
      'Emperor 本地密钥（保存在这台 Mac 的 Emperor 目录）',
    )
    expect(root.textContent).toContain('基础')
    expect(root.textContent).toContain('建议设置主密码')
    expect(root.textContent).not.toContain('钥匙串')
    expect(root.querySelector('.ds-settings-notice')).toBeNull()
    expect(root.textContent).toContain('尚未代填')
    expect(root.textContent).toContain('上次代填 2026')

    app?.unmount()
    api.vaultStatus.mockResolvedValue(status({ hasMasterPassword: true }))
    render(root)
    await settle()
    expect(root.textContent).toContain('本地密钥 + 主密码')
  })

  it('names the target of the last fill beside its time', async () => {
    const used: VaultEntry = {
      ...site,
      lastUsedAt: Date.UTC(2026, 8, 25, 6, 30),
      lastUsedTarget: 'https://site.test',
    }
    api.vaultStatus.mockResolvedValue(status({ handles: [used] }))
    const root = await mount()
    expect(root.textContent).toMatch(
      /上次代填 2026\S* \S+ · https:\/\/site\.test/,
    )
  })

  it('warns that a TOTP secret beside the password leaves one factor', async () => {
    api.vaultStatus.mockResolvedValue(status({ handles: [] }))
    const root = await mount()
    await openAdd()
    expect(document.body.textContent).not.toContain('两步验证就退化成了一步')
    await type(field(root, 'TOTP 密钥'), 'JBSWY3DPEHPK3PXP')
    expect(form()?.querySelector('.vault-warning')?.textContent).toContain(
      '把 TOTP 密钥和密码放在一起，两步验证就退化成了一步',
    )
  })

  it('removes a saved TOTP secret from an entry on request', async () => {
    const otp: VaultEntry = { ...site, fields: ['password', 'totp'] }
    api.vaultStatus.mockResolvedValue(status({ handles: [otp] }))
    api.vaultSave.mockResolvedValue(otp)
    const root = await mount()
    expect(() => checkbox(root, '删除已保存的 TOTP')).toThrow()
    button(root, '编辑').click()
    await settle()
    const seed = field(root, 'TOTP 密钥')
    expect(seed.placeholder).toContain('已保存')
    // A blank field keeps the saved secret.
    await submit(root)
    expect(api.vaultSave.mock.calls[0]![0]).not.toHaveProperty('totpSecret')

    button(root, '编辑').click()
    await settle()
    await type(field(root, 'TOTP 密钥'), 'JBSWY3DPEHPK3PXP')
    await tick(checkbox(root, '删除已保存的 TOTP'))
    expect(field(root, 'TOTP 密钥').disabled).toBe(true)
    expect(field(root, 'TOTP 密钥').value).toBe('')
    await submit(root)
    expect(api.vaultSave.mock.calls[1]![0]).toMatchObject({
      handleId: otp.handleId,
      totpSecret: '',
    })
  })

  it('flags app bindings without a Team ID as weakly verified', async () => {
    const unsigned: VaultEntry = {
      ...site,
      handleId: 'cred_eeeeeeeeeeeeeeeeeeeeeeee',
      label: 'Unsigned',
      bindings: [
        {
          kind: 'app',
          bundleId: 'com.example.Unsigned',
          path: '/Applications/Unsigned.app',
        },
      ],
    }
    const signed: VaultEntry = {
      ...site,
      handleId: 'cred_ffffffffffffffffffffffff',
      label: 'Signed',
      bindings: [
        { kind: 'app', bundleId: 'com.example.Writer', teamId: 'EXAMPLE123' },
      ],
    }
    api.vaultStatus.mockResolvedValue(status({ handles: [unsigned, signed] }))
    const root = await mount()
    const warnings = [...root.querySelectorAll('.vault-warning')].map(
      (item) => item.textContent,
    )
    expect(warnings).toEqual([
      'com.example.Unsigned：该应用未签名，身份校验较弱',
    ])
    // Registration shows the same warning (01 §7.9).
    await openAdd()
    const textarea = [...document.body.querySelectorAll('.vault-form label')]
      .find((item) => item.textContent?.includes('macOS App 绑定'))!
      .querySelector('textarea')!
    textarea.value = 'com.example.Other | | /Applications/Other.app'
    textarea.dispatchEvent(new Event('input'))
    await settle()
    expect(form()?.querySelector('.vault-warning')?.textContent).toContain(
      'com.example.Other：该应用未签名，身份校验较弱',
    )
  })

  it('unlocks and sets the master password in a dialog, with no Touch ID', async () => {
    api.vaultStatus.mockResolvedValue(
      status({ hasMasterPassword: true, locked: true }),
    )
    api.vaultUnlock.mockResolvedValue(true)
    const root = await mount()
    expect(document.body.textContent).not.toContain('Touch ID')
    // The page has no password field: 解锁 asks in a dialog.
    expect(root.querySelector('input[type="password"]')).toBeNull()
    button(root, '解锁').click()
    await settle()
    expect(document.body.textContent).not.toContain('Touch ID')
    expect(document.body.querySelector('label.vault-check')).toBeNull()
    await type(dialogInput('主密码'), 'correct horse battery')
    await submitProtect()
    expect(api.vaultUnlock).toHaveBeenCalledWith('correct horse battery')
    expect(document.body.querySelector('form.vault-protect')).toBeNull()

    app?.unmount()
    api.vaultStatus.mockResolvedValue(status())
    api.vaultMaster.mockResolvedValue(undefined)
    render(root)
    await settle()
    button(root, '设置').click()
    await settle()
    await type(dialogInput('新的主密码'), 'correct horse battery')
    await type(dialogInput('再次输入新的主密码'), 'correct horse battery')
    expect(document.body.textContent).not.toContain('Touch ID')
    await submitProtect()
    expect(api.vaultMaster).toHaveBeenCalledWith({
      action: 'set',
      password: 'correct horse battery',
      confirmPassword: 'correct horse battery',
    })
  })

  it('shows vault failures in Chinese and refreshes into the locked state', async () => {
    api.vaultStatus
      .mockResolvedValueOnce(status({ hasMasterPassword: true }))
      .mockResolvedValue(status({ hasMasterPassword: true, locked: true }))
    api.vaultReveal.mockRejectedValue(
      new Error(
        "Error invoking remote method 'emperor:computer-use:vault-reveal': Error: [credential-vault:vault-locked] credential vault is locked",
      ),
    )
    const root = await mount()
    button(root, '查看密码').click()
    await settle()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      '凭据库已锁定，请先用主密码解锁。',
    )
    // A notice at the top of the page, not a loose line.
    const notice = root.querySelector<HTMLElement>('.ds-settings-notice')
    expect(notice?.dataset.tone).toBe('error')
    expect(
      root.querySelector('.ds-settings-section > .body')?.firstElementChild,
    ).toBe(notice)
    expect(api.vaultStatus).toHaveBeenCalledTimes(2)
    expect(root.textContent).toContain('已锁定')
    expect(button(root, '解锁')).toBeTruthy()
    expect(addAction()).toBeUndefined()
    expect(form()).toBeNull()
  })

  it('says what the page is in one short sentence', async () => {
    api.vaultStatus.mockResolvedValue(status())
    const root = await mount()
    const intro =
      root.querySelector('.ds-settings-section .intro')?.textContent?.trim() ??
      ''
    expect(intro).not.toBe('')
    expect(intro.split(/[。！？；]/).filter(Boolean)).toHaveLength(1)
    expect(intro.length).toBeLessThanOrEqual(42)
  })

  /** The open Modal (role dialog) whose title is `title`. */
  function dialog(title: string): HTMLElement {
    const found = [
      ...document.body.querySelectorAll<HTMLElement>('[role="dialog"]'),
    ].find((item) => item.textContent?.includes(title))
    if (!found) throw new Error(`no dialog ${title}`)
    return found
  }

  function inputIn(root: HTMLElement, label: string): HTMLInputElement {
    const input = root.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    )
    if (!input) throw new Error(`no input ${label}`)
    return input
  }

  async function submitIn(root: HTMLElement): Promise<void> {
    root
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
  }

  it('shows 凭据库无法读取 and starts over only after confirming a backup (SEC-09 #1)', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    api.vaultStatus.mockResolvedValue(
      status({ available: false, problem: 'vault-unreadable', handles: [] }),
    )
    api.vaultStartOver.mockResolvedValue({
      backup: 'vault.json.unreadable-1700000000000',
    })
    const root = await mount()
    const notice = root.querySelector<HTMLElement>('.ds-settings-notice')!
    expect(notice.dataset.tone).toBe('error')
    expect(notice.textContent).toContain('凭据库无法读取')
    expect(notice.textContent).toContain('原文件')
    expect(button(notice, '从备份恢复')).toBeTruthy()
    expect(() => button(notice, '清空')).toThrow()
    expect(addAction()).toBeUndefined()
    button(notice, '重新开始（先备份）').click()
    await settle()
    expect(api.vaultStartOver).not.toHaveBeenCalled()
    const ask = dialog('重新开始')
    expect(ask.textContent).toContain('另存')
    api.vaultStatus.mockResolvedValue(status({ handles: [] }))
    button(ask, '备份并重新开始').click()
    await settle()
    expect(api.vaultStartOver).toHaveBeenCalledTimes(1)
    expect(
      root.querySelector('.ds-settings-notice[data-tone="error"]'),
    ).toBeNull()
    expect(root.textContent).toContain('vault.json.unreadable-1700000000000')
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('names a vault written by a newer Emperor and restores from a backup file (SEC-09 #2 #4)', async () => {
    api.vaultStatus.mockResolvedValue(
      status({ available: false, problem: 'vault-newer' }),
    )
    api.vaultImportPick.mockResolvedValue({ name: '凭据.emperor-vault' })
    api.vaultImport.mockResolvedValue({ imported: 2 })
    const root = await mount()
    const notice = root.querySelector<HTMLElement>('.ds-settings-notice')!
    expect(notice.textContent).toContain('更新版本的 Emperor')
    // Its entries are listed, read-only.
    expect(root.textContent).toContain('Site')
    expect(button(root, '编辑').disabled).toBe(true)
    button(notice, '从备份恢复').click()
    await settle()
    expect(api.vaultImportPick).toHaveBeenCalledTimes(1)
    const restore = dialog('从备份恢复')
    expect(restore.textContent).toContain('凭据.emperor-vault')
    await type(inputIn(restore, '备份口令'), 'backup passphrase 1')
    api.vaultStatus.mockResolvedValue(status())
    await submitIn(restore)
    expect(api.vaultImport).toHaveBeenCalledWith('backup passphrase 1')
    expect(root.textContent).toContain('已导入 2 个凭据')
  })

  it('offers 修复权限 first when the local key is open to others (SEC-09 #3)', async () => {
    api.vaultStatus.mockResolvedValue(
      status({ available: false, problem: 'key-permissions' }),
    )
    api.vaultRepairKey.mockResolvedValue(true)
    const root = await mount()
    const notice = root.querySelector<HTMLElement>('.ds-settings-notice')!
    expect(notice.textContent).toContain('权限')
    const repair = button(notice, '修复权限')
    expect(repair.dataset.variant).toBe('primary')
    api.vaultStatus.mockResolvedValue(status())
    repair.click()
    await settle()
    expect(api.vaultRepairKey).toHaveBeenCalledTimes(1)
    expect(api.vaultReset).not.toHaveBeenCalled()
    expect(root.querySelector('.ds-settings-notice')).toBeNull()
  })

  it('removes the master password only as its own action with the current one (SEC-09 #5)', async () => {
    api.vaultStatus.mockResolvedValue(status({ hasMasterPassword: true }))
    api.vaultMaster.mockResolvedValue(undefined)
    const root = await mount()
    // 更改 can no longer turn protection off: every field is required.
    button(root, '更改').click()
    await settle()
    expect(dialogInput('当前主密码').required).toBe(true)
    expect(dialogInput('新的主密码').required).toBe(true)
    expect(dialogInput('再次输入新的主密码').required).toBe(true)
    expect(document.body.textContent).not.toContain('留空保存会关闭主密码')
    await type(dialogInput('当前主密码'), 'correct horse battery')
    await type(dialogInput('新的主密码'), 'another passphrase')
    await type(dialogInput('再次输入新的主密码'), 'another passphrase')
    await submitProtect()
    expect(api.vaultMaster).toHaveBeenLastCalledWith({
      action: 'change',
      currentPassword: 'correct horse battery',
      password: 'another passphrase',
      confirmPassword: 'another passphrase',
    })

    const remove = button(root, '移除主密码')
    expect(remove.dataset.variant).toBe('danger')
    remove.click()
    await settle()
    const ask = dialog('移除主密码')
    await submitIn(ask)
    expect(api.vaultMaster).toHaveBeenCalledTimes(1)
    expect(ask.textContent).toContain('请输入当前主密码')
    await type(inputIn(ask, '当前主密码'), 'another passphrase')
    await submitIn(ask)
    expect(api.vaultMaster).toHaveBeenLastCalledWith({
      action: 'remove',
      currentPassword: 'another passphrase',
    })
  })

  it('refuses a new master password typed differently twice (SEC-09 #6)', async () => {
    api.vaultStatus.mockResolvedValue(status())
    const root = await mount()
    button(root, '设置').click()
    await settle()
    await type(dialogInput('新的主密码'), 'correct horse battery')
    await type(dialogInput('再次输入新的主密码'), 'correct horse batterY')
    await submitProtect()
    expect(api.vaultMaster).not.toHaveBeenCalled()
    expect(
      document.body.querySelector('form.vault-protect')?.textContent,
    ).toContain('两次输入的主密码不一致')
  })

  it('exports a backup under a passphrase typed twice (SEC-09 #4)', async () => {
    api.vaultStatus.mockResolvedValue(status())
    api.vaultExport.mockResolvedValue({ ok: true, name: '凭据.emperor-vault' })
    const root = await mount()
    button(root, '导出…').click()
    await settle()
    const ask = dialog('导出凭据备份')
    expect(ask.textContent).toContain('本地密钥')
    await type(inputIn(ask, '备份口令'), 'backup passphrase 1')
    await type(inputIn(ask, '再次输入备份口令'), 'backup passphrase 2')
    await submitIn(ask)
    expect(api.vaultExport).not.toHaveBeenCalled()
    expect(ask.textContent).toContain('两次输入的口令不一致')
    await type(inputIn(ask, '再次输入备份口令'), 'backup passphrase 1')
    await submitIn(ask)
    expect(api.vaultExport).toHaveBeenCalledWith(
      'backup passphrase 1',
      'backup passphrase 1',
    )
    expect(root.textContent).toContain('凭据.emperor-vault')
  })
})
