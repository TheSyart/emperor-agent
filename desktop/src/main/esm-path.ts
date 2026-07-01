import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export function moduleDirFromUrl(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl))
}
