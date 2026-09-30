// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileView } from '@emperor/core/runtime-contract'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from '../settingsHeader'
import SignInProfilesPage from './SignInProfilesPage.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../../api/http', () => ({ core }))

let app: App | null = null
let container: HTMLDivElement | null = null
let host: SettingsHeaderHost
let profiles: BrowserProfileView[]

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  host = createSettingsHeader()
  app = createApp({ render: () => h(SignInProfilesPage) })
  app.provide(SETTINGS_HEADER_KEY, host)
  app.mount(container)
  await settle()
  return container
}

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

async function typeName(value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(
    '.profile-form input',
  )!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await settle()
}

beforeEach(() => {
  profiles = [
    { profileId: 'temporary', name: '临时', kind: 'temporary', openTargets: 0 },
    { profileId: 'p1', name: '工作', kind: 'persistent', openTargets: 2 },
  ] as BrowserProfileView[]
  core.mockImplementation(async (key: string) =>
    key === 'computerUse.listProfiles' ? profiles : undefined,
  )
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  core.mockReset()
  vi.restoreAllMocks()
})

describe('登录状态', () => {
  it('lists persistent profiles apart from the temporary one', async () => {
    const root = await mount()
    const rows = [...root.querySelectorAll('[data-profile]')].map((row) =>
      row.getAttribute('data-profile'),
    )
    expect(rows).toEqual(['p1', 'temporary'])
    expect(root.textContent).toContain('2 个打开的标签页')
    expect(root.textContent).toContain('不保留登录')
    // The temporary profile cannot be renamed, cleared or deleted.
    expect(root.querySelector('[data-profile="temporary"] button')).toBeNull()
  })

  it('creates a profile from the header, in a dialog', async () => {
    await mount()
    const create = host.actions.value.find(
      (action) => action.id === 'new-profile',
    )
    expect(create?.label).toBe('新建')
    create!.onClick!()
    await settle()
    await typeName('  购物 ')
    document.body
      .querySelector('form.profile-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.manageProfile', {
      action: 'create',
      name: '购物',
    })
    expect(document.body.querySelector('form.profile-form')).toBeNull()
  })

  it('renames in a dialog and asks before clearing or deleting', async () => {
    const root = await mount()
    button(root, '重命名').click()
    await settle()
    const input = document.body.querySelector<HTMLInputElement>(
      '.profile-form input',
    )!
    expect(input.value).toBe('工作')
    await typeName('公司')
    document.body
      .querySelector('form.profile-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.manageProfile', {
      action: 'rename',
      profileId: 'p1',
      name: '公司',
    })

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    button(root, '清空').click()
    await settle()
    expect(core).not.toHaveBeenCalledWith(
      'computerUse.manageProfile',
      expect.objectContaining({ action: 'clear' }),
    )
    confirm.mockReturnValueOnce(true)
    button(root, '删除').click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.manageProfile', {
      action: 'delete',
      profileId: 'p1',
    })
  })

  it('keeps the dialog open with the reason when saving fails', async () => {
    core.mockImplementation(async (key: string) => {
      if (key === 'computerUse.manageProfile') throw new Error('名称已存在')
      return profiles
    })
    await mount()
    host.actions.value[0]!.onClick!()
    await settle()
    await typeName('工作')
    document.body
      .querySelector('form.profile-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(
      document.body.querySelector('.profile-form [role="alert"]')?.textContent,
    ).toBe('名称已存在')
  })
})
