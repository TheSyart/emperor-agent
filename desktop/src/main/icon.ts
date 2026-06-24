import * as path from 'node:path'

export interface ResolveAppIconPathOptions {
  dirname: string
  isPackaged: boolean
  resourcesPath: string
}

export function resolveAppIconPath({
  dirname,
  isPackaged,
  resourcesPath,
}: ResolveAppIconPathOptions): string {
  if (isPackaged) return path.join(resourcesPath, 'icon.png')
  return path.resolve(dirname, '..', '..', 'build', 'icon.png')
}
