// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalBrowserSettings } from '@emperor/core/runtime-contract'
import BrowserPermissionsGroup from './BrowserPermissionsGroup.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../../../api/http', () => ({ core }))

let app: App | null = null
let container: HTMLDivElement | null = null
let stored: ExternalBrowserSettings

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(BrowserPermissionsGroup) })
  app.mount(container)
  await settle()
  return container
}

function row(root: HTMLElement, title: string): HTMLElement {
  const found = [
    ...root.querySelectorAll<HTMLElement>('.ds-settings-row'),
  ].find((item) => item.querySelector('.title')?.textContent?.trim() === title)
  if (!found) throw new Error(`no row ${title}`)
  return found
}

async function pick(trigger: HTMLElement, label: string): Promise<void> {
  trigger.click()
  await settle()
  const item = [
    ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((entry) => entry.textContent?.includes(label))
  if (!item) throw new Error(`no option ${label}`)
  item.click()
  await settle()
}

beforeEach(() => {
  stored = {
    defaults: { browse: 'allow', download: 'ask' },
    sites: [],
    history: 'ask',
    siteTools: false,
  }
  core.mockImplementation(
    async (key: string, patch?: Partial<ExternalBrowserSettings>) => {
      if (key === 'computerUse.externalBrowserSettings') return stored
      if (key === 'computerUse.setExternalBrowserSettings') {
        stored = { ...stored, ...patch }
        return stored
      }
      return undefined
    },
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

describe('浏览器权限 · 历史记录', () => {
  it('shows 始终询问 by default and explains the row', async () => {
    const root = await mount()
    expect(root.querySelector('.ds-settings-group .title')?.textContent).toBe(
      '浏览器权限',
    )
    const history = row(root, '历史记录')
    expect(history.textContent).toContain(
      'Emperor 读取你的浏览历史前是否要你批准',
    )
    expect(history.querySelector('button')?.textContent).toContain('始终询问')
  })

  it('saves each choice at once: 始终允许, 从不', async () => {
    const root = await mount()
    const trigger = () =>
      row(root, '历史记录').querySelector<HTMLButtonElement>('button')!
    await pick(trigger(), '始终允许')
    expect(core).toHaveBeenLastCalledWith(
      'computerUse.setExternalBrowserSettings',
      { history: 'allow' },
    )
    await pick(trigger(), '从不')
    expect(core).toHaveBeenLastCalledWith(
      'computerUse.setExternalBrowserSettings',
      { history: 'never' },
    )
    expect(trigger().textContent).toContain('从不')
  })

  it('says why a change did not save and keeps the old choice', async () => {
    const root = await mount()
    core.mockRejectedValueOnce(new Error('请先处理当前的确认卡'))
    await pick(
      row(root, '历史记录').querySelector<HTMLButtonElement>('button')!,
      '始终允许',
    )
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      '请先处理当前的确认卡',
    )
    expect(
      row(root, '历史记录').querySelector('button')?.textContent,
    ).toContain('始终询问')
  })
})
