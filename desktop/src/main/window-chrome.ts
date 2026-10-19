/**
 * The main window's title bar (UI-S01): on macOS the native title bar is
 * hidden and the content fills the window; the traffic lights sit in the
 * top area of the renderer's 56px icon rail, centred on the 46px column top
 * bars below the 8px canvas gutter (centre line y = 8 + 46 / 2 = 31). The
 * renderer marks the empty rail top and the empty parts of the top bars as
 * drag regions (theme/base.css `[data-app-drag]`). window-chrome.test.ts
 * keeps these numbers equal to the renderer's tokens.
 */

/** Where the close button's top-left corner goes, in window points. */
export const TRAFFIC_LIGHTS = { x: 16, y: 24 } as const

/**
 * The three buttons as macOS 26 draws them: 14 × 14 each, 23 apart, so the
 * group is 60 wide. Content beside them starts 8px after (16 + 60 + 8 = 84,
 * `--shell-lights-clear`).
 */
export const TRAFFIC_LIGHTS_SIZE = { width: 60, height: 14 } as const

export type MainWindowChrome =
  | {
      titleBarStyle: 'hiddenInset'
      trafficLightPosition: { x: number; y: number }
    }
  | Record<string, never>

export function mainWindowChrome(
  platform: NodeJS.Platform = process.platform,
): MainWindowChrome {
  if (platform !== 'darwin') return {}
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { ...TRAFFIC_LIGHTS },
  }
}
