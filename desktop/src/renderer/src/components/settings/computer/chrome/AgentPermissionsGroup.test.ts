// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalBrowserSettings } from '@emperor/core/runtime-contract'
import AgentPermissionsGroup from './AgentPermissionsGroup.vue'

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
  app = createApp({ render: () => h(AgentPermissionsGroup) })
  app.mount(container)
  await settle()
  return container
}

function rows(root: HTMLElement): string[][] {
  return [...root.querySelectorAll<HTMLElement>('[role="row"]')].map((row) =>
    [
      ...row.querySelectorAll<HTMLElement>(
        '[role="cell"], [role="columnheader"]',
      ),
    ].map((cell) => cell.textContent?.trim() ?? ''),
  )
}

async function pick(trigger: HTMLElement, label: string): Promise<void> {
  trigger.click()
  await settle()
  const item = [
    ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((entry) => entry.textContent?.trim() === label)
  if (!item) throw new Error(`no option ${label}`)
  item.click()
  await settle()
}

function select(root: ParentNode, name: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`,
  )
  if (!found) throw new Error(`no select ${name}`)
  return found
}

beforeEach(() => {
  stored = {
    defaults: { browse: 'allow', download: 'ask' },
    sites: [
      { pattern: '*.mybank.example', browse: 'ask', download: 'block' },
      { pattern: 'github.com', browse: 'allow', download: 'allow' },
    ],
    history: 'ask',
    siteTools: false,
  }
  core.mockImplementation(
    async (key: string, patch?: Record<string, unknown>) => {
      if (key === 'computerUse.externalBrowserSettings') return stored
      if (key === 'computerUse.setExternalBrowserSettings') {
        const sites =
          (patch?.sites as ExternalBrowserSettings['sites']) ?? stored.sites
        if (sites.some((rule) => rule.pattern.includes('/')))
          throw new Error('「example.com/path」不是有效的网站或模式')
        stored = {
          ...stored,
          ...(patch ?? {}),
          defaults: {
            ...stored.defaults,
            ...((patch?.defaults as object | undefined) ?? {}),
          },
          sites: sites.map((rule) => ({
            ...rule,
            pattern: rule.pattern.trim().toLowerCase(),
          })),
        }
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

describe('智能体权限', () => {
  it('shows the default row and each exception, like the preview', async () => {
    const root = await mount()
    expect(root.querySelector('.ds-settings-group .title')?.textContent).toBe(
      '智能体权限',
    )
    expect(root.textContent).toContain('选择默认权限，并为特定网站添加例外')
    expect(rows(root)).toEqual([
      ['网站或模式', '浏览', '下载', ''],
      ['默认', '允许', '需要批准', ''],
      ['*.mybank.example', '需要批准', '阻止', ''],
      ['github.com', '允许', '允许', ''],
    ])
    expect(root.textContent).toContain('此处仅显示设置了自定义权限的网站')
    // The default row cannot be removed; each exception can.
    expect(
      [...root.querySelectorAll('button[aria-label^="删除"]')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['删除 *.mybank.example', '删除 github.com'])
    // Colors follow the decision (阻止 reads as an error, 需要批准 as a warning).
    expect(select(root, '*.mybank.example 下载').dataset.decision).toBe('block')
    expect(select(root, '默认 下载').dataset.decision).toBe('ask')
  })

  it('changes the default at once', async () => {
    const root = await mount()
    await pick(select(root, '默认 下载'), '阻止')
    expect(core).toHaveBeenCalledWith(
      'computerUse.setExternalBrowserSettings',
      {
        defaults: { download: 'block' },
      },
    )
    expect(rows(root)[1]).toEqual(['默认', '允许', '阻止', ''])
  })

  it('changes and removes an exception, keeping the others', async () => {
    const root = await mount()
    await pick(select(root, 'github.com 浏览'), '需要批准')
    expect(core).toHaveBeenLastCalledWith(
      'computerUse.setExternalBrowserSettings',
      {
        sites: [
          { pattern: '*.mybank.example', browse: 'ask', download: 'block' },
          { pattern: 'github.com', browse: 'ask', download: 'allow' },
        ],
      },
    )
    root
      .querySelector<HTMLButtonElement>(
        'button[aria-label="删除 *.mybank.example"]',
      )!
      .click()
    await settle()
    expect(core).toHaveBeenLastCalledWith(
      'computerUse.setExternalBrowserSettings',
      { sites: [{ pattern: 'github.com', browse: 'ask', download: 'allow' }] },
    )
    expect(rows(root).map((row) => row[0])).toEqual([
      '网站或模式',
      '默认',
      'github.com',
    ])
  })

  it('adds a site from the dialog and shows it as saved', async () => {
    const root = await mount()
    root
      .querySelector<HTMLButtonElement>('[data-action="add-site-rule"]')!
      .click()
    await settle()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('添加网站')
    const input = dialog.querySelector<HTMLInputElement>('input')!
    input.value = ' News.Example '
    input.dispatchEvent(new Event('input'))
    await settle()
    await pick(select(dialog, '新网站 浏览'), '阻止')
    await pick(select(dialog, '新网站 下载'), '阻止')
    dialog
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(core).toHaveBeenLastCalledWith(
      'computerUse.setExternalBrowserSettings',
      {
        sites: [
          { pattern: '*.mybank.example', browse: 'ask', download: 'block' },
          { pattern: 'github.com', browse: 'allow', download: 'allow' },
          { pattern: 'News.Example', browse: 'block', download: 'block' },
        ],
      },
    )
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(rows(root).at(-1)).toEqual(['news.example', '阻止', '阻止', ''])
  })

  it('keeps the dialog open and says what is wrong with a pattern', async () => {
    const root = await mount()
    root
      .querySelector<HTMLButtonElement>('[data-action="add-site-rule"]')!
      .click()
    await settle()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const input = dialog.querySelector<HTMLInputElement>('input')!
    input.value = 'example.com/path'
    input.dispatchEvent(new Event('input'))
    await settle()
    dialog
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(dialog.textContent).toContain('不是有效的网站或模式')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('says so when the settings cannot be read', async () => {
    core.mockRejectedValueOnce(new Error('电脑操作在这台电脑上不可用'))
    const root = await mount()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      '电脑操作在这台电脑上不可用',
    )
    expect(root.querySelectorAll('[role="row"]')).toHaveLength(1)
  })
})
