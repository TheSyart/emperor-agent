// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserProfileView,
  SitePermission,
} from '@emperor/core/runtime-contract'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from '../settingsHeader'
import SiteSettingsPage from './SiteSettingsPage.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../../api/http', () => ({ core }))

let app: App | null = null
let container: HTMLDivElement | null = null
let host: SettingsHeaderHost
let permissions: SitePermission[]

const profiles = [
  { profileId: 'temporary', name: '临时', kind: 'temporary', openTargets: 0 },
  { profileId: 'p1', name: '工作', kind: 'persistent', openTargets: 0 },
] as BrowserProfileView[]

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  host = createSettingsHeader()
  app = createApp({ render: () => h(SiteSettingsPage) })
  app.provide(SETTINGS_HEADER_KEY, host)
  app.mount(container)
  await settle()
  return container
}

async function fill(selector: string, value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await settle()
}

beforeEach(() => {
  permissions = []
  core.mockImplementation(async (key: string) =>
    key === 'computerUse.listProfiles'
      ? profiles
      : key === 'computerUse.listSitePermissions'
        ? permissions
        : undefined,
  )
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  core.mockReset()
})

describe('网站设置', () => {
  it('says nothing is allowed yet', async () => {
    const root = await mount()
    expect(root.textContent).toContain('暂无')
    expect(root.textContent).toContain('默认一律拒绝')
  })

  it('lists what was allowed, by profile name, and revokes it', async () => {
    permissions = [
      {
        profileId: 'p1',
        origin: 'https://meet.example.com',
        kind: 'camera',
        expiresAt: '2026-10-01T10:00:00Z',
      },
    ] as SitePermission[]
    const root = await mount()
    expect(root.textContent).toContain('https://meet.example.com')
    expect(root.textContent).toContain('摄像头 · 工作 · 到期')
    const revoke = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '撤销',
    )!
    revoke.click()
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setSitePermission', {
      profileId: 'p1',
      origin: 'https://meet.example.com',
      kind: 'camera',
      allow: false,
    })
  })

  it('allows a site from the header dialog, for a limited time if asked', async () => {
    await mount()
    const allow = host.actions.value.find(
      (action) => action.id === 'allow-site',
    )
    expect(allow?.label).toBe('放行')
    allow!.onClick!()
    await settle()
    await fill(
      '.site-form input[placeholder="https://example.com"]',
      ' https://meet.example.com ',
    )
    await fill('.site-form input[type="number"]', '30')
    document.body
      .querySelector('form.site-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(core).toHaveBeenCalledWith('computerUse.setSitePermission', {
      profileId: 'temporary',
      origin: 'https://meet.example.com',
      kind: 'notifications',
      allow: true,
      minutes: 30,
    })
    expect(document.body.querySelector('form.site-form')).toBeNull()
  })
})
