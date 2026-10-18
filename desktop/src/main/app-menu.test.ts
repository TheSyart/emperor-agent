import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, menuRoles } from './app-menu'

function flatten(
  items: readonly MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ])
}

const DEV_ONLY = ['reload', 'forceReload', 'toggleDevTools']

function template(packaged: boolean, actions = {}) {
  return applicationMenuTemplate({
    appName: 'Emperor Agent',
    packaged,
    platform: 'darwin',
    openSettings: () => undefined,
    openHelp: () => undefined,
    ...actions,
  })
}

describe('application menu (MAIN-20)', () => {
  it('offers no DevTools and no reload in a packaged build', () => {
    const items = flatten(template(true))
    const roles = items.map((item) => String(item.role ?? ''))
    for (const role of DEV_ONLY)
      expect(roles.map((value) => value.toLowerCase())).not.toContain(
        role.toLowerCase(),
      )
    const accelerators = items.map((item) => String(item.accelerator ?? ''))
    for (const key of ['CmdOrCtrl+R', 'Shift+CmdOrCtrl+R', 'Alt+CmdOrCtrl+I'])
      expect(accelerators).not.toContain(key)
    expect(
      items.some(
        (item) =>
          typeof item.click === 'function' &&
          /开发者|重新/.test(String(item.label)),
      ),
    ).toBe(false)
  })

  it('has the app, edit, view, window and help menus', () => {
    const menus = template(true)
    expect(menus.map((menu) => menu.label ?? menu.role)).toEqual([
      'Emperor Agent',
      '编辑',
      '显示',
      '窗口',
      '帮助',
    ])
    const roles = flatten(menus).map((item) => item.role)
    for (const role of [
      'about',
      'hide',
      'quit',
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'selectAll',
      'minimize',
      'close',
      'togglefullscreen',
    ])
      expect(roles).toContain(role)
  })

  it('opens settings from 偏好设置… (⌘,) and help from the help menu', () => {
    const openSettings = vi.fn()
    const openHelp = vi.fn()
    const items = flatten(template(true, { openSettings, openHelp }))
    const preferences = items.find((item) => item.label === '偏好设置…')
    expect(preferences?.accelerator).toBe('CmdOrCtrl+,')
    preferences?.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    )
    expect(openSettings).toHaveBeenCalledOnce()
    const help = items.find((item) => item.label === 'Emperor Agent 帮助')
    help?.click?.(undefined as never, undefined as never, undefined as never)
    expect(openHelp).toHaveBeenCalledOnce()
  })

  it('keeps reload and DevTools for development builds', () => {
    const roles = flatten(template(false)).map((item) => item.role)
    for (const role of DEV_ONLY) expect(roles).toContain(role)
  })
})

describe('menuRoles', () => {
  it('lists the roles of an installed menu, submenus included', () => {
    expect(
      menuRoles({
        items: [
          { role: 'appmenu', submenu: { items: [{ role: 'about' }, {}] } },
          { submenu: { items: [{ role: 'copy', submenu: null }] } },
        ],
      }),
    ).toEqual(['appmenu', 'about', 'copy'])
    expect(menuRoles(null)).toEqual([])
  })
})
