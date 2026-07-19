import type { WebPreferences } from 'electron'
import { resolveMainPreloadPath } from './preload-path'

export function mainWindowWebPreferences(mainDir: string): WebPreferences {
  return {
    preload: resolveMainPreloadPath(mainDir),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [],
  }
}
