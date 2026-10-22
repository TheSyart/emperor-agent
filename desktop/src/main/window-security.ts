import type { WebPreferences } from 'electron'
import { resolveMainPreloadPath } from './preload-path'

/**
 * The main window's renderer: sandboxed, isolated, no Node. A packaged build
 * has no DevTools at all (MAIN-20); the app menu offers neither DevTools nor
 * reload there either (app-menu.ts).
 */
export function mainWindowWebPreferences(
  mainDir: string,
  options: { packaged: boolean },
): WebPreferences {
  return {
    preload: resolveMainPreloadPath(mainDir),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    devTools: !options.packaged,
    additionalArguments: [],
  }
}
