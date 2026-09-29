/**
 * Emergency-stop entries besides the global shortcut (spec 00 §6.6): while
 * computer use is on, the macOS Dock menu offers 停止电脑操作; when the
 * shortcut could not be registered (another app owns it) a menu-bar tray
 * icon offers it too. Resuming stays in Settings.
 */

export interface StopEntryState {
  readonly enabled: boolean
  readonly stopped: boolean
  readonly shortcutRegistered: boolean
}

export interface StopMenuItem {
  readonly label: string
  readonly enabled: boolean
  readonly click?: () => void
}

export interface StopEntryHost {
  /** `null` removes Emperor's items from the Dock menu. */
  setDockMenu(items: readonly StopMenuItem[] | null): void
  showTray(items: readonly StopMenuItem[], tooltip: string): void
  hideTray(): void
}

export interface StopEntryActions {
  stop(): void
  showApp(): void
}

export function stopMenuItems(
  state: StopEntryState,
  actions: StopEntryActions,
): StopMenuItem[] {
  return [
    state.stopped
      ? { label: '电脑操作已停止（在设置中恢复）', enabled: false }
      : { label: '停止电脑操作', enabled: true, click: actions.stop },
    { label: '显示 Emperor', enabled: true, click: actions.showApp },
  ]
}

export interface StopEntries {
  sync(state: StopEntryState): void
  dispose(): void
}

export function createStopEntries(
  host: StopEntryHost,
  actions: StopEntryActions,
): StopEntries {
  let last = ''
  let trayShown = false
  const hideTray = (): void => {
    if (!trayShown) return
    trayShown = false
    host.hideTray()
  }
  return {
    sync(state) {
      const key = JSON.stringify(state)
      if (key === last) return
      last = key
      if (!state.enabled) {
        host.setDockMenu(null)
        hideTray()
        return
      }
      const items = stopMenuItems(state, actions)
      host.setDockMenu(items)
      if (state.shortcutRegistered) hideTray()
      else {
        trayShown = true
        host.showTray(items, 'Emperor 电脑操作：快捷键不可用，可从这里停止')
      }
    },
    dispose() {
      host.setDockMenu(null)
      hideTray()
      last = ''
    },
  }
}
