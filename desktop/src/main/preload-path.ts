import * as path from 'node:path'

export function resolveMainPreloadPath(mainDir: string): string {
  return path.join(mainDir, '..', 'preload', 'index.mjs')
}
