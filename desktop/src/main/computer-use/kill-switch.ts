/**
 * Computer Use emergency stop shortcut (spec 00 §6.6, decision D6):
 * ⌃⌥⌘. on macOS, Ctrl+Alt+Shift+. on Windows and Linux. A failed
 * registration (another app owns the combination) is reported in the
 * status so Settings can say so; the Settings stop button still works.
 */

export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered(accelerator: string): boolean
}

export interface KillSwitchStatus {
  readonly accelerator: string
  readonly registered: boolean
  readonly error?: string
}

export function defaultKillSwitchAccelerator(
  platform: NodeJS.Platform,
): string {
  return platform === 'darwin' ? 'Control+Alt+Command+.' : 'Control+Alt+Shift+.'
}

export interface KillSwitch {
  status(): KillSwitchStatus
  /** (Re)register; returns the new status. */
  register(accelerator?: string): KillSwitchStatus
  /** Release the shortcut while computer use is switched off. */
  unregister(): void
  /**
   * Remember the user's combination without registering it (computer use
   * is off); `register()` uses it later.
   */
  setAccelerator(accelerator: string): void
  dispose(): void
}

export function createKillSwitch(options: {
  readonly shortcuts: GlobalShortcutLike
  readonly platform: NodeJS.Platform
  readonly onTrigger: () => void
}): KillSwitch {
  let accelerator = defaultKillSwitchAccelerator(options.platform)
  let registered = false
  let error: string | undefined

  const release = (): void => {
    if (!registered) return
    try {
      options.shortcuts.unregister(accelerator)
    } catch {
      // the app is going away anyway
    }
    registered = false
  }

  const killSwitch: KillSwitch = {
    status: () => ({
      accelerator,
      registered,
      ...(error === undefined ? {} : { error }),
    }),
    register(next) {
      release()
      if (next !== undefined && next.trim() !== '') accelerator = next.trim()
      error = undefined
      try {
        registered = options.shortcuts.register(accelerator, () => {
          try {
            options.onTrigger()
          } catch {
            // the stop path must never throw into Electron
          }
        })
        if (!registered) error = '快捷键已被其他应用占用'
      } catch (cause) {
        registered = false
        error = cause instanceof Error ? cause.message : String(cause)
      }
      return killSwitch.status()
    },
    unregister: () => {
      release()
      error = undefined
    },
    setAccelerator: (next) => {
      if (next.trim() === '' || next.trim() === accelerator) return
      if (registered) {
        killSwitch.register(next)
        return
      }
      accelerator = next.trim()
      error = undefined
    },
    dispose: release,
  }
  return killSwitch
}
