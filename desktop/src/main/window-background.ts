/**
 * The main window's colour before the renderer paints (DS-01): the theme's
 * `--surface-canvas`, so opening the app no longer flashes a third colour.
 * The renderer's stored theme choice is not readable here; the system
 * appearance decides, which matches the default 「跟随系统」. Kept equal to
 * theme/semantic.*.css by window-background.test.ts.
 */
const CANVAS = { dark: '#151517', light: '#ffffff' } as const

export function windowBackground(systemDark: boolean): string {
  return systemDark ? CANVAS.dark : CANVAS.light
}
