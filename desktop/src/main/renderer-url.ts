/** The page of Emperor's main window. */
export const PRODUCTION_RENDERER_URL = 'app://bundle/index.html'

/**
 * electron-vite's dev server, from ELECTRON_RENDERER_URL, outside a packaged
 * app only (MAIN-10): a packaged Emperor would otherwise load whatever page
 * that variable names (`launchctl setenv` reaches every app of the user),
 * and give it the main window's IPC.
 */
export function developmentRendererUrl(options: {
  readonly isPackaged: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}): string | null {
  if (options.isPackaged) return null
  return options.env.ELECTRON_RENDERER_URL || null
}

/** What the main window loads: the dev server in development, else the bundle. */
export function mainRendererUrl(options: {
  readonly isPackaged: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}): string {
  return developmentRendererUrl(options) ?? PRODUCTION_RENDERER_URL
}
