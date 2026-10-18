import type { MenuItemConstructorOptions } from 'electron'

export interface ApplicationMenuOptions {
  readonly appName: string
  /** Packaged builds get no reload and no DevTools (MAIN-20). */
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
  /** 偏好设置… (⌘,): open 设置 in the main window. */
  openSettings(): void
  /** 帮助 › Emperor Agent 帮助. */
  openHelp(): void
}

/**
 * Emperor's own application menu instead of Electron's default one, which
 * offers DevTools and ⌘R / ⇧⌘R in every build: a reload drops the UI, and
 * with it pauses the Agent's Computer Use. A packaged build keeps the
 * standard app, edit, view (zoom and full screen), window and help menus;
 * development builds add reload and DevTools to 显示.
 */
export function applicationMenuTemplate(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin'
  const name = options.appName
  const preferences: MenuItemConstructorOptions = {
    label: '偏好设置…',
    accelerator: 'CmdOrCtrl+,',
    click: () => options.openSettings(),
  }
  const appMenu: MenuItemConstructorOptions = {
    label: name,
    submenu: [
      { role: 'about', label: `关于 ${name}` },
      { type: 'separator' },
      preferences,
      { type: 'separator' },
      ...(mac
        ? ([
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: `隐藏 ${name}` },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { role: 'quit', label: `退出 ${name}` },
    ],
  }
  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '拷贝' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'delete', label: '删除' },
      { role: 'selectAll', label: '全选' },
    ],
  }
  const development: MenuItemConstructorOptions[] = options.packaged
    ? []
    : [
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
      ]
  const viewMenu: MenuItemConstructorOptions = {
    label: '显示',
    submenu: [
      ...development,
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '切换全屏幕' },
    ],
  }
  const windowMenu: MenuItemConstructorOptions = {
    label: '窗口',
    role: 'window',
    submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      { role: 'close', label: '关闭窗口' },
      ...(mac
        ? ([
            { type: 'separator' },
            { role: 'front', label: '前置全部窗口' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
    ],
  }
  const helpMenu: MenuItemConstructorOptions = {
    label: '帮助',
    role: 'help',
    submenu: [{ label: `${name} 帮助`, click: () => options.openHelp() }],
  }
  return [appMenu, editMenu, viewMenu, windowMenu, helpMenu]
}
