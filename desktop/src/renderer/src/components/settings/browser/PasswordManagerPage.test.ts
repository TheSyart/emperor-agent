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
  vaultSetMaster: vi.fn(),
  vaultReveal: vi.fn(),
  vaultBiometricUnlock: vi.fn(),
  vaultBiometricDisable: vi.fn(),
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
    backend: 'keychain',
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

/** Submit the master password / Touch ID dialog. */
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

  it('explains that a basic_text backend leaves the vault disabled', async () => {
    api.vaultStatus.mockResolvedValue(
      status({ available: false, backend: 'basic_text', handles: [] }),
    )
    const root = await mount()
    expect(root.textContent).toContain('无保护')
    expect(root.textContent).toContain('basic_text')
    expect(root.textContent).toContain('GNOME Keyring 或 KWallet')
    expect(root.textContent).toContain('凭据库已停用')
    expect(addAction()).toBeUndefined()
    expect(form()).toBeNull()
  })

  it('shows protection strength and each entry’s last fill', async () => {
    const used: VaultEntry = {
      ...site,
      handleId: 'cred_dddddddddddddddddddddddd',
      label: 'Used',
      lastUsedAt: Date.UTC(2026, 8, 25, 6, 30),
    }
    api.vaultStatus.mockResolvedValue(
      status({ backend: 'dpapi', handles: [site, used] }),
    )
    const root = await mount()
    expect(root.textContent).toContain('Windows DPAPI')
    expect(root.textContent).toContain('基础')
    expect(root.textContent).toContain('建议设置主密码')
    expect(root.textContent).toContain('尚未代填')
    expect(root.textContent).toContain('上次代填 2026')

    app?.unmount()
    api.vaultStatus.mockResolvedValue(
      status({ backend: 'gnome_libsecret', hasMasterPassword: true }),
    )
    render(root)
    await settle()
    expect(root.textContent).toContain('系统加密 + 主密码')
    expect(root.textContent).toContain('GNOME Keyring')
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

  it('unlocks with Touch ID once the user opted in with the password', async () => {
    api.vaultStatus.mockResolvedValue(
      status({
        hasMasterPassword: true,
        locked: true,
        biometricSupported: true,
        biometricUnlock: false,
      }),
    )
    api.vaultUnlock.mockResolvedValue(true)
    const root = await mount()
    expect(() => button(root, '使用 Touch ID')).toThrow()
    // The page has no password field: 解锁 asks in a dialog.
    expect(root.querySelector('input[type="password"]')).toBeNull()
    button(root, '解锁').click()
    await settle()
    await type(dialogInput('主密码'), 'correct horse battery')
    await tick(checkbox(root, '允许 Touch ID 解锁'))
    await submitProtect()
    expect(api.vaultUnlock).toHaveBeenCalledWith('correct horse battery', {
      biometric: true,
    })
    expect(document.body.querySelector('form.vault-protect')).toBeNull()

    app?.unmount()
    api.vaultStatus.mockResolvedValue(
      status({
        hasMasterPassword: true,
        locked: true,
        biometricSupported: true,
        biometricUnlock: true,
      }),
    )
    api.vaultBiometricUnlock.mockResolvedValue(true)
    api.vaultBiometricDisable.mockResolvedValue(undefined)
    render(root)
    await settle()
    expect(root.textContent).toContain('用主密码或 Touch ID 解锁后')
    expect(() => checkbox(root, '允许 Touch ID 解锁')).toThrow()
    button(root, '使用 Touch ID').click()
    await settle()
    expect(api.vaultBiometricUnlock).toHaveBeenCalledTimes(1)
    // Turning it off works while locked.
    button(root, '关闭').click()
    await settle()
    expect(api.vaultBiometricDisable).toHaveBeenCalledTimes(1)
  })

  it('offers Touch ID with a new master password and hides it where unsupported', async () => {
    api.vaultStatus.mockResolvedValue(status({ biometricSupported: true }))
    api.vaultSetMaster.mockResolvedValue(undefined)
    const root = await mount()
    expect(root.querySelector('input[type="password"]')).toBeNull()
    button(root, '设置').click()
    await settle()
    // The Touch ID choice shows up once there is a password to go with it.
    expect(() => checkbox(root, '允许 Touch ID 解锁')).toThrow()
    await type(dialogInput('新的主密码'), 'correct horse battery')
    await tick(checkbox(root, '允许 Touch ID 解锁'))
    await submitProtect()
    expect(api.vaultSetMaster).toHaveBeenCalledWith('correct horse battery', {
      biometric: true,
    })

    app?.unmount()
    api.vaultStatus.mockResolvedValue(
      status({
        hasMasterPassword: true,
        biometricSupported: true,
        biometricUnlock: false,
      }),
    )
    api.vaultUnlock.mockResolvedValue(true)
    render(root)
    await settle()
    // Unlocked and not yet on: re-enter the master password to opt in.
    button(root, '开启').click()
    await settle()
    await type(dialogInput('确认主密码'), 'correct horse battery')
    await submitProtect()
    expect(api.vaultUnlock).toHaveBeenCalledWith('correct horse battery', {
      biometric: true,
    })

    app?.unmount()
    api.vaultStatus.mockResolvedValue(
      status({ hasMasterPassword: true, locked: true }),
    )
    render(root)
    await settle()
    expect(root.textContent).not.toContain('Touch ID')
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
})
